import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeMuseAdapterShape } from "./Adapter.ts";
import type { MuseHostFactory, MuseNotification, MuseTransport } from "./Client.ts";

/** Deterministic fake: first turn stays running until cancelled; later turns queue. */
function makeControlsHost() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let counter = 0;
  let options: Parameters<MuseHostFactory>[0] | undefined;
  let running: string | undefined;
  const emit = (n: MuseNotification) => options?.onNotification?.(n);
  const transport: MuseTransport = {
    initializeResult: {
      grantedCapabilities: ["sessionMcp"],
      sessionDurability: "durable",
      museHome: "/fake-home",
    },
    mintCommandId: () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`,
    command: async (method, params) => {
      calls.push({ method, params });
      if (method === "session/start") {
        return {
          session: {
            sessionId: params.sessionId,
            activeTurnId: null,
            modelId: "muse-spark-1.3",
            providerId: "meta",
          },
          viewCursor: "c1",
        };
      }
      if (method === "turn/start") {
        const turnId = String(params.commandId);
        if (running) {
          return {
            commandId: params.commandId,
            status: "accepted",
            turnId,
            disposition: "queued",
            startedNewTurn: false,
          };
        }
        running = turnId;
        queueMicrotask(() => emit({ method: "turn/started", params: { turnId } }));
        return {
          commandId: params.commandId,
          status: "accepted",
          turnId,
          disposition: "started",
          startedNewTurn: true,
        };
      }
      if (method === "turn/unqueue") {
        queueMicrotask(() =>
          emit({
            method: "turn/unqueued",
            params: { turnId: params.turnId, commandId: "queued-submission" },
          }),
        );
        return { commandId: params.commandId, status: "accepted", turnId: params.turnId };
      }
      if (method === "turn/cancel") {
        queueMicrotask(() => {
          emit({
            method: "turn/completed",
            params: { turnId: params.turnId, terminal: "cancelled" },
          });
          running = undefined;
        });
        return { commandId: params.commandId, status: "accepted", turnId: params.turnId };
      }
      return { commandId: params.commandId, status: "accepted" };
    },
    request: async (method: string) =>
      method === "account/read"
        ? { state: "accountLogin", credentialRequired: true }
        : { session: { activeTurnId: running ?? null, modelId: "muse-spark-1.3" } },
    onNotification: () => undefined,
    onServerRequest: () => undefined,
    close: async () => undefined,
  };
  return {
    calls,
    factory: (async (hostOptions) => {
      options = hostOptions;
      return transport;
    }) satisfies MuseHostFactory,
  };
}

const threadId = ThreadId.makeUnsafe("thread-muse-controls");

describe("Muse Stop / queued reclaim", () => {
  it("reclaims the queued turn by exact ID without touching the running turn, then cancels running by exact ID", async () => {
    const fake = makeControlsHost();
    const completedStates: Array<unknown> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeMuseAdapterShape({
          hostFactory: fake.factory,
          getSettings: Effect.succeed({ enabled: true, binaryPath: "muse" }),
          platformQualified: true,
        });
        const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            if (event.type === "turn.completed") completedStates.push(event.payload.state);
          }),
        ).pipe(Effect.forkDetach);
        yield* Effect.sleep(10);
        yield* adapter.startSession({
          threadId,
          cwd: "/workspace",
          runtimeMode: "auto-accept-edits",
          modelSelection: { provider: "muse", model: "muse-spark-1.3", subProviderID: "meta" },
        });
        const first = yield* adapter.sendTurn({ threadId, input: "long" });
        const second = yield* adapter.sendTurn({ threadId, input: "queued one" });
        expect(second.turnId).not.toBe(first.turnId);
        // Stop the queued submission: exact-ID unqueue, no cancel of the running turn.
        yield* adapter.interruptTurn(threadId, second.turnId);
        expect(
          fake.calls.some((c) => c.method === "turn/unqueue" && c.params.turnId === second.turnId),
        ).toBe(true);
        expect(fake.calls.some((c) => c.method === "turn/cancel")).toBe(false);
        // Stop the running turn: exact-ID turn/cancel (Phase 0 qualified).
        yield* adapter.interruptTurn(threadId, first.turnId);
        const cancel = fake.calls.find((c) => c.method === "turn/cancel");
        expect(cancel?.params.turnId).toBe(first.turnId);
        yield* Effect.sleep(20);
        yield* Fiber.interrupt(fiber);
      }),
    );
    // Queued reclaim settles interrupted with no synthesized start; running settles interrupted.
    expect(completedStates).toEqual(["interrupted", "interrupted"]);
  });
});
