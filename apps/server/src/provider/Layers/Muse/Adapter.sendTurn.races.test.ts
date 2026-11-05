import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeMuseTestHost, startInput, threadId } from "./Adapter.failures.test.helpers.ts";

describe("Muse late admission acknowledgements", () => {
  it.each(["turn/completed", "turn/unqueued"] as const)(
    "does not resurrect a queued ack after %s, even when another turn settles later",
    async (terminalMethod) => {
      const host = makeMuseTestHost();
      const original = host.transport.command;
      host.transport.command = async (method, params, cid) => {
        const raw = await original(method, params, cid);
        if (method !== "turn/start") return raw;
        host.emit({ method: "turn/started", params: { turnId: cid } });
        host.emit({ method: terminalMethod, params: { turnId: cid, terminal: "completed" } });
        host.emit({ method: "turn/completed", params: { turnId: "other", terminal: "completed" } });
        return { ...raw, disposition: "queued", startedNewTurn: false };
      };
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* host.adapter();
          yield* adapter.startSession(startInput);
          const ack = yield* adapter.sendTurn({ threadId, input: "work" });
          expect((yield* adapter.listSessions())[0]).toMatchObject({ status: "ready" });
          expect((yield* adapter.listSessions())[0]?.activeTurnId).toBeUndefined();
          yield* adapter.interruptTurn(threadId, ack.turnId);
          expect(host.calls.at(-1)?.method).toBe("turn/cancel");
          yield* adapter.stopAll();
        }),
      );
    },
  );
  it("preserves a native authoritative turn ID and an observed start before a queued ack", async () => {
    const host = makeMuseTestHost();
    const original = host.transport.command;
    host.transport.command = async (method, params, cid) => {
      const raw = await original(method, params, cid);
      if (method !== "turn/start") return raw;
      host.emit({ method: "turn/started", params: { turnId: "native-authoritative" } });
      return {
        ...raw,
        turnId: "native-authoritative",
        disposition: "queued",
        startedNewTurn: false,
      };
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* host.adapter();
        yield* adapter.startSession(startInput);
        const ack = yield* adapter.sendTurn({ threadId, input: "work" });
        expect(ack.turnId).toBe("native-authoritative");
        expect((yield* adapter.listSessions())[0]?.activeTurnId).toBe("native-authoritative");
        yield* adapter.interruptTurn(threadId, ack.turnId);
        expect(host.calls.at(-1)?.method).toBe("turn/cancel");
        yield* adapter.stopAll();
      }),
    );
  });
  it("authoritative terminal inspection wins over stale local queued tracking", async () => {
    const host = makeMuseTestHost();
    const original = host.transport.command;
    host.transport.command = async (method, params, cid) => ({
      ...(await original(method, params, cid)),
      ...(method === "turn/start" ? { disposition: "queued", startedNewTurn: false } : {}),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* host.adapter();
        yield* adapter.startSession(startInput);
        const ack = yield* adapter.sendTurn({ threadId, input: "work" });
        host.transport.request = async () => ({
          session: { sessionId: host.sessionId(), activeTurnId: null },
          lastTurn: { turnId: ack.turnId, terminal: "failed" },
        });
        expect((yield* adapter.inspectActiveTurn(threadId, ack.turnId)).status).toBe("failed");
        yield* adapter.stopAll();
      }),
    );
  });
});
