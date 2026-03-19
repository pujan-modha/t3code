/**
 * Git process helpers - Effect-native git execution with typed errors.
 *
 * Centralizes child-process git invocation for server modules. This module
 * only executes git commands and reports structured failures.
 *
 * @module GitServiceLive
 */
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Option, Schema, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { GitCommandError } from "../Errors.ts";
import {
  type ExecuteGitInput,
  type ExecuteGitProgress,
  type ExecuteGitResult,
  GitService,
  type GitServiceShape,
} from "../Services/GitService.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const TRACE2_POLL_INTERVAL_MS = 100;

interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

function quoteGitCommand(args: ReadonlyArray<string>): string {
  return `git ${args.join(" ")}`;
}

function toGitCommandError(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  detail: string,
) {
  return (cause: unknown) =>
    Schema.is(GitCommandError)(cause)
      ? cause
      : new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${cause instanceof Error && cause.message.length > 0 ? cause.message : "Unknown error"} - ${detail}`,
          ...(cause !== undefined ? { cause } : {}),
        });
}

function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") {
    return String(childId);
  }
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}

function parseTraceRecord(
  line: string,
): { ok: true; record: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, message: "Trace line was not an object." };
    }
    return { ok: true, record: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const createTrace2Monitor = Effect.fn(function* (
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: ExecuteGitProgress | undefined,
): Effect.fn.Return<Trace2Monitor, never, Scope.Scope> {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return {
      env: {},
      flush: Effect.void,
    };
  }

  const traceFilePath = join(tmpdir(), `t3code-git-trace2-${process.pid}-${randomUUID()}.json`);
  const hookStartByChildKey = new Map<string, { hookName: string; startedAtMs: number }>();
  let processedChars = 0;
  let lineBuffer = "";
  let polling = false;

  const handleTraceLine = (line: string) =>
    Effect.gen(function* () {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 0) {
        return;
      }

      const parsedRecord = parseTraceRecord(trimmedLine);
      if (!parsedRecord.ok) {
        yield* Effect.logDebug(
          `GitService.trace2: failed to parse trace line for ${quoteGitCommand(input.args)} in ${input.cwd}: ${
            parsedRecord.message
          }`,
        );
        return;
      }
      const record = parsedRecord.record;

      if (record.child_class !== "hook") {
        return;
      }

      const event = record.event;
      const childKey = trace2ChildKey(record);
      if (childKey === null) {
        return;
      }
      const started = hookStartByChildKey.get(childKey);
      const hookNameFromEvent = typeof record.hook_name === "string" ? record.hook_name.trim() : "";
      const hookName = hookNameFromEvent.length > 0 ? hookNameFromEvent : (started?.hookName ?? "");
      if (hookName.length === 0) {
        return;
      }

      if (event === "child_start") {
        hookStartByChildKey.set(childKey, { hookName, startedAtMs: Date.now() });
        if (progress.onHookStarted) {
          yield* progress.onHookStarted(hookName);
        }
        return;
      }

      if (event === "child_exit") {
        hookStartByChildKey.delete(childKey);
        if (progress.onHookFinished) {
          const code = record.code;
          yield* progress.onHookFinished({
            hookName: started?.hookName ?? hookName,
            exitCode: typeof code === "number" && Number.isInteger(code) ? code : null,
            durationMs: started ? Math.max(0, Date.now() - started.startedAtMs) : null,
          });
        }
      }
    });

  const pollTraceFile = Effect.tryPromise({
    try: async () => {
      if (polling) {
        return "";
      }
      polling = true;
      try {
        const contents = await readFile(traceFilePath, "utf8").catch((error: unknown) => {
          const code =
            typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
          if (code === "ENOENT") {
            return "";
          }
          throw error;
        });
        if (contents.length <= processedChars) {
          return "";
        }
        const delta = contents.slice(processedChars);
        processedChars = contents.length;
        return delta;
      } finally {
        polling = false;
      }
    },
    catch: () => undefined,
  }).pipe(
    Effect.catch(() => Effect.succeed("")),
    Effect.flatMap((delta) =>
      Effect.gen(function* () {
        if (delta.length === 0) {
          return;
        }
        lineBuffer += delta;
        let newlineIndex = lineBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = lineBuffer.slice(0, newlineIndex);
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          yield* handleTraceLine(line);
          newlineIndex = lineBuffer.indexOf("\n");
        }
      }),
    ),
  );

  const interval = setInterval(() => {
    void Effect.runPromise(pollTraceFile);
  }, TRACE2_POLL_INTERVAL_MS);

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      clearInterval(interval);
      yield* pollTraceFile;
      const finalLine = lineBuffer.trim();
      if (finalLine.length > 0) {
        yield* handleTraceLine(finalLine);
      }
      yield* Effect.tryPromise({
        try: () => unlink(traceFilePath),
        catch: () => undefined,
      }).pipe(Effect.ignore);
    }),
  );

  return {
    env: {
      GIT_TRACE2_EVENT: traceFilePath,
    },
    flush: pollTraceFile,
  };
});

const collectOutput = Effect.fn(function* <E>(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, E>,
  maxOutputBytes: number,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
): Effect.fn.Return<string, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let lineBuffer = "";

  const emitCompleteLines = (flush: boolean) =>
    Effect.gen(function* () {
      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (line.length > 0 && onLine) {
          yield* onLine(line);
        }
        newlineIndex = lineBuffer.indexOf("\n");
      }

      if (flush) {
        const trailing = lineBuffer.replace(/\r$/, "");
        lineBuffer = "";
        if (trailing.length > 0 && onLine) {
          yield* onLine(trailing);
        }
      }
    });

  yield* Stream.runForEach(stream, (chunk) =>
    Effect.gen(function* () {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        return yield* new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
        });
      }
      const decoded = decoder.decode(chunk, { stream: true });
      text += decoded;
      lineBuffer += decoded;
      yield* emitCompleteLines(false);
    }),
  ).pipe(Effect.mapError(toGitCommandError(input, "output stream failed.")));

  const remainder = decoder.decode();
  text += remainder;
  lineBuffer += remainder;
  yield* emitCompleteLines(true);
  return text;
});

const makeGitService = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const execute: GitServiceShape["execute"] = Effect.fnUntraced(function* (input) {
    const commandInput = {
      ...input,
      args: [...input.args],
    } as const;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const commandEffect = Effect.gen(function* () {
      const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress);
      const child = yield* commandSpawner
        .spawn(
          ChildProcess.make("git", commandInput.args, {
            cwd: commandInput.cwd,
            env: {
              ...process.env,
              ...input.env,
              ...trace2Monitor.env,
            },
          }),
        )
        .pipe(Effect.mapError(toGitCommandError(commandInput, "failed to spawn.")));

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectOutput(commandInput, child.stdout, maxOutputBytes, input.progress?.onStdoutLine),
          collectOutput(commandInput, child.stderr, maxOutputBytes, input.progress?.onStderrLine),
          child.exitCode.pipe(
            Effect.map((value) => Number(value)),
            Effect.mapError(toGitCommandError(commandInput, "failed to report exit code.")),
          ),
        ],
        { concurrency: "unbounded" },
      );
      yield* trace2Monitor.flush;

      if (!input.allowNonZeroExit && exitCode !== 0) {
        const trimmedStderr = stderr.trim();
        return yield* new GitCommandError({
          operation: commandInput.operation,
          command: quoteGitCommand(commandInput.args),
          cwd: commandInput.cwd,
          detail:
            trimmedStderr.length > 0
              ? `${quoteGitCommand(commandInput.args)} failed: ${trimmedStderr}`
              : `${quoteGitCommand(commandInput.args)} failed with code ${exitCode}.`,
        });
      }

      return { code: exitCode, stdout, stderr } satisfies ExecuteGitResult;
    });

    return yield* commandEffect.pipe(
      Effect.scoped,
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () =>
            Effect.fail(
              new GitCommandError({
                operation: commandInput.operation,
                command: quoteGitCommand(commandInput.args),
                cwd: commandInput.cwd,
                detail: `${quoteGitCommand(commandInput.args)} timed out.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  });

  return {
    execute,
  } satisfies GitServiceShape;
});

export const GitServiceLive = Layer.effect(GitService, makeGitService);
