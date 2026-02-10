import { describe, expect, it, afterEach, vi } from "vitest";
import { createServer } from "./wsServer";
import WebSocket from "ws";

import { WS_CHANNELS, WS_METHODS, type WsPush, type WsResponse } from "@acme/contracts";

interface PendingMessages {
  queue: unknown[];
  waiters: Array<(message: unknown) => void>;
}

const pendingBySocket = new WeakMap<WebSocket, PendingMessages>();

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending: PendingMessages = { queue: [], waiters: [] };
    pendingBySocket.set(ws, pending);

    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      const waiter = pending.waiters.shift();
      if (waiter) {
        waiter(parsed);
        return;
      }
      pending.queue.push(parsed);
    });

    ws.once("open", () => resolve(ws));
    ws.once("error", () => reject(new Error("WebSocket connection failed")));
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  const pending = pendingBySocket.get(ws);
  if (!pending) {
    return Promise.reject(new Error("WebSocket not initialized"));
  }

  const queued = pending.queue.shift();
  if (queued !== undefined) {
    return Promise.resolve(queued);
  }

  return new Promise((resolve) => {
    pending.waiters.push(resolve);
  });
}

async function sendRequest(
  ws: WebSocket,
  method: string,
  params?: unknown,
): Promise<WsResponse> {
  const id = crypto.randomUUID();
  const message = JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) });
  ws.send(message);

  // Wait for response with matching id
  while (true) {
    const parsed = (await waitForMessage(ws)) as Record<string, unknown>;
    if (parsed.id === id) {
      return parsed as WsResponse;
    }
  }
}

describe("WebSocket Server", () => {
  let server: ReturnType<typeof createServer> | null = null;
  const connections: WebSocket[] = [];

  afterEach(() => {
    for (const ws of connections) {
      ws.close();
    }
    connections.length = 0;
    server?.stop();
    server = null;
    vi.restoreAllMocks();
  });

  it("sends welcome message on connect", async () => {
    server = createServer({ port: 0, cwd: "/test/project" });
    // Get the actual port after listen
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ws = await connectWs(port);
    connections.push(ws);

    const message = (await waitForMessage(ws)) as WsPush;
    expect(message.type).toBe("push");
    expect(message.channel).toBe(WS_CHANNELS.serverWelcome);
    expect(message.data).toEqual({
      cwd: "/test/project",
      projectName: "project",
    });
  });

  it("logs outbound websocket push events in dev mode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      // Keep test output clean while verifying websocket logs.
    });

    server = createServer({
      port: 0,
      cwd: "/test/project",
      devUrl: "http://localhost:5173",
    });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    expect(
      logSpy.mock.calls.some(([message]) => {
        if (typeof message !== "string") return false;
        return (
          message.includes("[ws]") &&
          message.includes("outgoing push") &&
          message.includes(`channel="${WS_CHANNELS.serverWelcome}"`)
        );
      }),
    ).toBe(true);
  });

  it("responds to server.getConfig", async () => {
    server = createServer({ port: 0, cwd: "/my/workspace" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome message
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ cwd: "/my/workspace" });
  });

  it("returns error for unknown methods", async () => {
    server = createServer({ port: 0, cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome
    await waitForMessage(ws);

    const response = await sendRequest(ws, "nonexistent.method");
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Unknown method");
  });

  it("responds to providers.listSessions with empty array", async () => {
    server = createServer({ port: 0, cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.providersListSessions);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual([]);
  });

  it("handles invalid JSON gracefully", async () => {
    server = createServer({ port: 0, cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome
    await waitForMessage(ws);

    // Send garbage
    ws.send("not json at all");

    const response = (await waitForMessage(ws)) as WsResponse;
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Invalid request format");
  });
});
