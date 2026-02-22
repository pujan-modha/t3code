import type { DomainEventEnvelope } from "../domain/events";
import type {
  AppViewState,
  ChatMessage,
  ProviderEvent,
  ProviderSessionView,
  ThreadView,
} from "../domain/models";
import { emptyAppViewState } from "../domain/models";

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function eventTurnId(event: ProviderEvent): string | undefined {
  if (event.turnId) return event.turnId;
  const turn = asObject(asObject(event.payload)?.turn);
  return asString(turn?.id);
}

function durationMs(startIso: string, endIso: string): number | undefined {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return end - start;
}

function evolveSession(previous: ProviderSessionView, event: ProviderEvent): ProviderSessionView {
  const payload = asObject(event.payload);
  if (event.method === "thread/started") {
    const thread = asObject(payload?.thread);
    return {
      ...previous,
      threadId: asString(thread?.id) ?? event.threadId ?? previous.threadId,
      updatedAt: event.createdAt,
    };
  }
  if (event.method === "turn/started") {
    const turn = asObject(payload?.turn);
    return {
      ...previous,
      status: "running",
      activeTurnId: asString(turn?.id) ?? event.turnId ?? previous.activeTurnId,
      updatedAt: event.createdAt,
    };
  }
  if (event.method === "turn/completed") {
    const turn = asObject(payload?.turn);
    const status = asString(turn?.status);
    const turnError = asObject(turn?.error);
    return {
      ...previous,
      status: status === "failed" ? "error" : "ready",
      activeTurnId: undefined,
      lastError: asString(turnError?.message) ?? previous.lastError,
      updatedAt: event.createdAt,
    };
  }
  if (event.kind === "error") {
    return {
      ...previous,
      status: "error",
      lastError: event.message ?? previous.lastError,
      updatedAt: event.createdAt,
    };
  }
  if (event.method === "session/closed" || event.method === "session/exited") {
    return {
      ...previous,
      status: "closed",
      activeTurnId: undefined,
      lastError: event.message ?? previous.lastError,
      updatedAt: event.createdAt,
    };
  }
  return { ...previous, updatedAt: event.createdAt };
}

function applyEventToMessages(
  previous: ReadonlyArray<ChatMessage>,
  event: ProviderEvent,
): ChatMessage[] {
  const payload = asObject(event.payload);
  if (event.method === "item/started") {
    const item = asObject(payload?.item);
    if (asString(item?.type) !== "agentMessage") return [...previous];
    const itemId = asString(item?.id);
    if (!itemId) return [...previous];
    const seedText = asString(item?.text) ?? "";
    return [
      ...previous.filter((entry) => entry.id !== itemId),
      {
        id: itemId,
        role: "assistant",
        text: seedText,
        createdAt: event.createdAt,
        streaming: true,
      },
    ];
  }
  if (event.method === "item/agentMessage/delta") {
    const itemId = event.itemId ?? asString(payload?.itemId);
    const delta = event.textDelta ?? asString(payload?.delta) ?? "";
    if (!itemId || !delta) return [...previous];
    const idx = previous.findIndex((entry) => entry.id === itemId);
    if (idx < 0) {
      return [
        ...previous,
        { id: itemId, role: "assistant", text: delta, createdAt: event.createdAt, streaming: true },
      ];
    }
    const next = [...previous];
    const current = next[idx];
    if (!current) return [...previous];
    next[idx] = { ...current, text: `${current.text}${delta}`, streaming: true };
    return next;
  }
  if (event.method === "item/completed") {
    const item = asObject(payload?.item);
    if (asString(item?.type) !== "agentMessage") return [...previous];
    const itemId = asString(item?.id);
    if (!itemId) return [...previous];
    const fullText = asString(item?.text);
    const idx = previous.findIndex((entry) => entry.id === itemId);
    if (idx < 0) {
      return [
        ...previous,
        {
          id: itemId,
          role: "assistant",
          text: fullText ?? "",
          createdAt: event.createdAt,
          streaming: false,
        },
      ];
    }
    const next = [...previous];
    const current = next[idx];
    if (!current) return [...previous];
    next[idx] = { ...current, text: fullText ?? current.text, streaming: false };
    return next;
  }
  if (event.method === "turn/completed") {
    return previous.map((entry) => ({ ...entry, streaming: false }));
  }
  return [...previous];
}

function defaultThread(payload: {
  id: string;
  projectId: string;
  title: string;
  model: string;
  createdAt: string;
  branch: string | null;
  worktreePath: string | null;
}): ThreadView {
  return {
    id: payload.id,
    codexThreadId: null,
    projectId: payload.projectId,
    title: payload.title,
    model: payload.model,
    terminalOpen: false,
    terminalHeight: 280,
    terminalIds: ["default"],
    runningTerminalIds: [],
    activeTerminalId: "default",
    terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
    activeTerminalGroupId: "group-default",
    session: null,
    messages: [],
    events: [],
    error: null,
    createdAt: payload.createdAt,
    branch: payload.branch,
    worktreePath: payload.worktreePath,
    turnDiffSummaries: [],
  };
}

export function applyDomainEvent(state: AppViewState, event: DomainEventEnvelope): AppViewState {
  switch (event.type) {
    case "app.bootstrapped": {
      const payload = event.payload as { cwd: string; projectName: string };
      if (state.projects.length > 0)
        return { ...state, threadsHydrated: true, lastPosition: event.position };
      return {
        ...state,
        projects: [
          {
            id: "bootstrap-project",
            name: payload.projectName,
            cwd: payload.cwd,
            model: "gpt-5.3-codex",
            expanded: true,
            scripts: [],
          },
        ],
        threadsHydrated: true,
        lastPosition: event.position,
      };
    }
    case "project.added": {
      const payload = event.payload as {
        id: string;
        name: string;
        cwd: string;
        model: string;
        scripts: Array<{ id: string; name: string; command: string; keybinding?: string }>;
      };
      if (
        state.projects.some((project) => project.id === payload.id || project.cwd === payload.cwd)
      ) {
        return { ...state, lastPosition: event.position };
      }
      return {
        ...state,
        projects: [...state.projects, { ...payload, expanded: true }],
        lastPosition: event.position,
      };
    }
    case "project.removed": {
      const payload = event.payload as { id: string };
      return {
        ...state,
        projects: state.projects.filter((project) => project.id !== payload.id),
        threads: state.threads.filter((thread) => thread.projectId !== payload.id),
        lastPosition: event.position,
      };
    }
    case "project.scriptsUpdated": {
      const payload = event.payload as {
        id: string;
        scripts: Array<{ id: string; name: string; command: string; keybinding?: string }>;
      };
      return {
        ...state,
        projects: state.projects.map((project) =>
          project.id === payload.id ? { ...project, scripts: payload.scripts } : project,
        ),
        lastPosition: event.position,
      };
    }
    case "thread.created": {
      const payload = event.payload as {
        id: string;
        projectId: string;
        title: string;
        model: string;
        createdAt: string;
        branch: string | null;
        worktreePath: string | null;
      };
      if (state.threads.some((thread) => thread.id === payload.id)) {
        return { ...state, lastPosition: event.position };
      }
      return {
        ...state,
        threads: [...state.threads, defaultThread(payload)],
        lastPosition: event.position,
      };
    }
    case "thread.deleted": {
      const payload = event.payload as { id: string };
      return {
        ...state,
        threads: state.threads.filter((thread) => thread.id !== payload.id),
        lastPosition: event.position,
      };
    }
    case "thread.userMessageAdded": {
      const payload = event.payload as {
        threadId: string;
        messageId: string;
        text: string;
        createdAt: string;
        attachments?: Array<{
          type: "image";
          id: string;
          name: string;
          mimeType: string;
          sizeBytes: number;
          previewUrl?: string;
        }>;
      };
      return {
        ...state,
        threads: state.threads.map((thread) =>
          thread.id === payload.threadId
            ? {
                ...thread,
                messages: [
                  ...thread.messages,
                  {
                    id: payload.messageId,
                    role: "user",
                    text: payload.text,
                    attachments: payload.attachments ? [...payload.attachments] : undefined,
                    createdAt: payload.createdAt,
                    streaming: false,
                  },
                ],
              }
            : thread,
        ),
        lastPosition: event.position,
      };
    }
    case "thread.providerSessionUpdated": {
      const payload = event.payload as { threadId: string; session: ProviderSessionView | null };
      return {
        ...state,
        threads: state.threads.map((thread) =>
          thread.id === payload.threadId
            ? {
                ...thread,
                session: payload.session,
                codexThreadId: payload.session?.threadId ?? thread.codexThreadId,
                ...(payload.session ? {} : { events: [], messages: [], turnDiffSummaries: [] }),
              }
            : thread,
        ),
        lastPosition: event.position,
      };
    }
    case "thread.providerEventRecorded": {
      const payload = event.payload as { threadId: string; event: ProviderEvent };
      return {
        ...state,
        threads: state.threads.map((thread) => {
          if (thread.id !== payload.threadId) return thread;
          const nextEvents = [payload.event, ...thread.events];
          const nextSession = thread.session
            ? evolveSession(thread.session, payload.event)
            : thread.session;
          const nextMessages = applyEventToMessages(thread.messages, payload.event);
          const nextTurnId =
            payload.event.method === "turn/started"
              ? (eventTurnId(payload.event) ?? thread.latestTurnId)
              : thread.latestTurnId;
          const nextTurnStartedAt =
            payload.event.method === "turn/started"
              ? payload.event.createdAt
              : thread.latestTurnStartedAt;
          const nextTurnCompletedAt =
            payload.event.method === "turn/completed"
              ? payload.event.createdAt
              : thread.latestTurnCompletedAt;
          const nextTurnDuration =
            payload.event.method === "turn/completed" && thread.latestTurnStartedAt
              ? durationMs(thread.latestTurnStartedAt, payload.event.createdAt)
              : thread.latestTurnDurationMs;
          return {
            ...thread,
            events: nextEvents,
            messages: nextMessages,
            session: nextSession,
            error:
              payload.event.kind === "error" && payload.event.message
                ? payload.event.message
                : thread.error,
            latestTurnId: nextTurnId,
            latestTurnStartedAt: nextTurnStartedAt,
            latestTurnCompletedAt: nextTurnCompletedAt,
            latestTurnDurationMs: nextTurnDuration,
          };
        }),
        lastPosition: event.position,
      };
    }
    case "thread.branchSet": {
      const payload = event.payload as {
        threadId: string;
        branch: string | null;
        worktreePath: string | null;
      };
      return {
        ...state,
        threads: state.threads.map((thread) =>
          thread.id === payload.threadId
            ? { ...thread, branch: payload.branch, worktreePath: payload.worktreePath }
            : thread,
        ),
        lastPosition: event.position,
      };
    }
    case "thread.terminalActivitySet": {
      const payload = event.payload as { threadId: string; terminalId: string; running: boolean };
      return {
        ...state,
        threads: state.threads.map((thread) => {
          if (thread.id !== payload.threadId) return thread;
          const running = new Set(thread.runningTerminalIds);
          if (payload.running) running.add(payload.terminalId);
          else running.delete(payload.terminalId);
          const terminalIds = thread.terminalIds.includes(payload.terminalId)
            ? thread.terminalIds
            : [...thread.terminalIds, payload.terminalId];
          return { ...thread, terminalIds, runningTerminalIds: [...running] };
        }),
        lastPosition: event.position,
      };
    }
    case "thread.markVisited": {
      const payload = event.payload as { threadId: string; visitedAt: string };
      return {
        ...state,
        threads: state.threads.map((thread) =>
          thread.id === payload.threadId ? { ...thread, lastVisitedAt: payload.visitedAt } : thread,
        ),
        lastPosition: event.position,
      };
    }
    case "runtime.modeSet": {
      const payload = event.payload as { mode: "approval-required" | "full-access" };
      return { ...state, runtimeMode: payload.mode, lastPosition: event.position };
    }
    default:
      return { ...state, lastPosition: event.position };
  }
}

export function reduceEvents(
  events: ReadonlyArray<DomainEventEnvelope>,
  seed?: AppViewState,
): AppViewState {
  return events.reduce(
    (state, event) => applyDomainEvent(state, event),
    seed ?? emptyAppViewState(),
  );
}
