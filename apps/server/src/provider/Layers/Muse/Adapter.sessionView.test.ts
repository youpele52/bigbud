import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeMuseAdapterShape } from "./Adapter.ts";
import type { MuseHostFactory, MuseNotification, MuseTransport } from "./Client.ts";

const threadId = ThreadId.makeUnsafe("thread-muse-view");

/**
 * A host whose turns stay open until the test emits their notifications,
 * mirroring the native ordering: the turn/start ack resolves first, and
 * turn/completed arrives seconds later (after reminder children settle).
 */
function makeManualHost(options: { readonly completeBeforeAck?: boolean } = {}) {
  let counter = 0;
  let hostOptions: Parameters<MuseHostFactory>[0] | undefined;
  const emit = (notification: MuseNotification) => hostOptions?.onNotification?.(notification);
  const transport: MuseTransport = {
    initializeResult: {
      grantedCapabilities: ["sessionMcp"],
      sessionDurability: "durable",
      serverVersion: "1.4.14",
      museHome: "/fake-muse-home",
    },
    mintCommandId: () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`,
    command: async (method, params) => {
      if (method === "session/start") {
        return {
          session: {
            sessionId: params.sessionId,
            activeTurnId: null,
            modelId: "muse-spark-1.3",
            providerId: "meta",
          },
          viewCursor: "cursor-1",
          history: { mode: "inline" },
          pendingRequests: [],
        };
      }
      if (method === "turn/start") {
        const turnId = String(params.commandId);
        if (options.completeBeforeAck) {
          emit({ method: "turn/started", params: { turnId } });
          emit({ method: "turn/completed", params: { turnId, terminal: "completed" } });
        }
        return {
          commandId: turnId,
          status: "accepted",
          turnId,
          disposition: "started",
          startedNewTurn: true,
        };
      }
      return { commandId: params.commandId, status: "accepted" };
    },
    request: async (method) =>
      method === "account/read" ? { state: "accountLogin", credentialRequired: true } : {},
    onNotification: () => undefined,
    onServerRequest: () => undefined,
    close: async () => undefined,
  };
  const factory: MuseHostFactory = async (received) => {
    hostOptions = received;
    return transport;
  };
  return { factory, emit };
}

const startInput = {
  threadId,
  cwd: "/workspace",
  runtimeMode: "auto-accept-edits" as const,
  modelSelection: { provider: "muse" as const, model: "muse-spark-1.3", subProviderID: "meta" },
  sessionEpoch: 3,
};

function makeAdapter(host: ReturnType<typeof makeManualHost>) {
  return makeMuseAdapterShape({
    hostFactory: host.factory,
    getSettings: Effect.succeed({ enabled: true, binaryPath: "muse" }),
    platformQualified: true,
  });
}

describe("Muse live session view", () => {
  it("reports the foreground turn as running until its native terminal arrives", async () => {
    const host = makeManualHost();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeAdapter(host);
        const started = yield* adapter.startSession(startInput);
        expect(started).toMatchObject({ status: "ready", sessionEpoch: 3 });

        const { turnId } = yield* adapter.sendTurn({ threadId, input: "hello" });
        // ProviderService reads this right after sendTurn: an idle answer here
        // would claim the turn's terminal and drop the real turn.completed.
        const [running] = yield* adapter.listSessions();
        expect(running).toMatchObject({ status: "running", activeTurnId: turnId, sessionEpoch: 3 });
        const [again] = yield* adapter.listSessions();
        expect(again?.updatedAt).toBe(running?.updatedAt);

        host.emit({ method: "turn/started", params: { turnId } });
        host.emit({ method: "turn/completed", params: { turnId, terminal: "completed" } });
        const [settled] = yield* adapter.listSessions();
        expect(settled).toMatchObject({ status: "ready" });
        expect(settled?.activeTurnId).toBeUndefined();
      }),
    );
  });

  it("does not reactivate a turn whose terminal arrived before the turn/start ack", async () => {
    const host = makeManualHost({ completeBeforeAck: true });
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeAdapter(host);
        yield* adapter.startSession(startInput);
        yield* adapter.sendTurn({ threadId, input: "hello" });
        const [session] = yield* adapter.listSessions();
        expect(session).toMatchObject({ status: "ready" });
      }),
    );
  });

  it("stamps the orchestration session epoch on every runtime event", async () => {
    const host = makeManualHost();
    const events: Array<ProviderRuntimeEvent> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeAdapter(host);
        const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event)),
        ).pipe(Effect.forkDetach);
        yield* Effect.sleep(10);
        yield* adapter.startSession(startInput);
        const { turnId } = yield* adapter.sendTurn({ threadId, input: "hello" });
        host.emit({ method: "turn/started", params: { turnId } });
        host.emit({
          method: "item/started",
          params: { item: { itemId: "agent-1", kind: "agentMessage", turnId } },
        });
        host.emit({
          method: "item/delta",
          params: { itemId: "agent-1", field: "text", delta: "hi" },
        });
        host.emit({ method: "turn/completed", params: { turnId, terminal: "completed" } });
        yield* adapter.stopSession(threadId);
        yield* Effect.sleep(30);
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "item.started",
      "content.delta",
      "turn.completed",
      "session.exited",
    ]);
    expect(events.every((event) => event.sessionEpoch === 3)).toBe(true);
  });
});
