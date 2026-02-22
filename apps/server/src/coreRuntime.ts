import path from "node:path";
import crypto from "node:crypto";
import type { ProviderEvent, ProviderSession } from "@t3tools/contracts";
import {
  EffectFanout,
  OrchestrationEngine,
  QueueProjector,
  type AppViewState,
} from "@t3tools/core";
import { createSqliteStores } from "@t3tools/infra-sqlite";

import type { ProviderManager } from "./providerManager";

function nowIso(): string {
  return new Date().toISOString();
}

export class CoreRuntime {
  private readonly fanout = new EffectFanout();
  private readonly stores;
  private readonly projector: QueueProjector;
  private readonly engine: OrchestrationEngine;

  constructor(dbDir: string) {
    const dbPath = path.join(dbDir, "event-store.sqlite");
    this.stores = createSqliteStores(dbPath);
    this.projector = new QueueProjector(this.stores.projectionStore, this.fanout);
    this.engine = new OrchestrationEngine(
      this.stores.eventStore,
      this.stores.projectionStore,
      this.projector,
    );
  }

  async start(cwd: string, projectName: string): Promise<void> {
    await this.engine.start();
    await this.engine.execute({
      id: crypto.randomUUID(),
      type: "app.bootstrap",
      issuedAt: nowIso(),
      payload: { cwd, projectName },
    });
  }

  async stop(): Promise<void> {
    await this.engine.stop();
    this.stores.db.close();
  }

  async state(): Promise<AppViewState> {
    return this.engine.currentState();
  }

  async dispatch(command: Parameters<OrchestrationEngine["execute"]>[0]): Promise<AppViewState> {
    return this.engine.execute(command);
  }

  subscribe() {
    return this.fanout.subscribe();
  }

  bindProviderEvents(providerManager: ProviderManager): void {
    providerManager.on("event", (event: ProviderEvent) => {
      void this.ingestProviderEvent(event);
    });
  }

  async bindProviderSession(threadId: string, session: ProviderSession): Promise<void> {
    await this.dispatch({
      id: crypto.randomUUID(),
      type: "thread.updateProviderSession",
      issuedAt: nowIso(),
      payload: { threadId, session },
    });
  }

  async clearProviderSession(threadId: string): Promise<void> {
    await this.dispatch({
      id: crypto.randomUUID(),
      type: "thread.updateProviderSession",
      issuedAt: nowIso(),
      payload: { threadId, session: null },
    });
  }

  async ingestProviderEvent(event: ProviderEvent): Promise<void> {
    const state = await this.state();
    const target = state.threads.find((thread) => thread.session?.sessionId === event.sessionId);
    if (!target) return;
    await this.dispatch({
      id: crypto.randomUUID(),
      type: "thread.recordProviderEvent",
      issuedAt: event.createdAt,
      payload: {
        threadId: target.id,
        event,
      },
    });
  }
}
