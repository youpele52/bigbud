import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { MuseSessionBindingsShape } from "../../../persistence/Services/MuseSessionBindings.ts";
import {
  approvalParams,
  makeMuseTestHost,
  startInput,
  threadId,
} from "./Adapter.failures.test.helpers.ts";

const bindings: MuseSessionBindingsShape = {
  find: () =>
    Effect.succeed({
      threadId,
      nativeSessionId: "native",
      creationCommandId: "creation",
      workspace: process.cwd(),
      storageIdentity: "home",
      selectionFingerprint: "fp",
      createdAt: "now",
      phase: "bound",
      revision: 1,
    }),
  reserve: () => Effect.die("unused"),
  transition: () => Effect.die("unused"),
};

describe("Muse exact resume state and immediate callbacks", () => {
  it.each(["v", "new-head"])(
    "does not erase admitted queue state when a %s read omits queue identities",
    async (viewCursor) => {
      const host = makeMuseTestHost();
      const original = host.transport.command;
      host.transport.command = async (method, params, cid) => {
        const raw = await original(method, params, cid);
        if (method !== "session/resume") return raw;
        return {
          ...raw,
          history: {
            mode: "snapshot",
            snapshot: {
              viewCursor: "v",
              state: {
                activeTurn: null,
                queuedTurns: [{ turnId: "queued-native", commandId: "submit-queued" }],
              },
            },
          },
        };
      };
      const read = host.transport.request;
      host.transport.request = async (method, params) =>
        method === "session/read"
          ? { session: { sessionId: "native", activeTurnId: null }, viewCursor }
          : read(method, params);
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* host.adapter({ bindings });
          const session = yield* adapter.startSession(startInput);
          expect(session.status).toBe("running");
          if (viewCursor === "v") {
            yield* adapter.interruptTurn(threadId, "queued-native" as never);
            expect(host.calls.at(-1)?.method).toBe("turn/unqueue");
          } else {
            expect(
              (yield* adapter.inspectActiveTurn(threadId, "queued-native" as never)).status,
            ).toBe("unavailable");
          }
          yield* adapter.stopAll();
        }),
      );
    },
  );
  it.each(["active", "idle", "queued"])(
    "restores %s from authoritative read, and newer null does not resurrect resume active state",
    async (mode) => {
      const host = makeMuseTestHost();
      const original = host.transport.command;
      host.transport.command = async (method, params, cid) => {
        const raw = await original(method, params, cid);
        return method === "session/resume"
          ? { ...raw, session: { ...(raw.session as object), activeTurnId: "stale-active" } }
          : raw;
      };
      const read = host.transport.request;
      host.transport.request = async (method, params) =>
        method !== "session/read"
          ? read(method, params)
          : {
              session: {
                sessionId: "native",
                activeTurnId: mode === "active" ? "active-native" : null,
                modelId: startInput.modelSelection.model,
              },
              viewCursor: "v",
              history: {
                mode: "snapshot",
                snapshot: {
                  viewCursor: "v",
                  state: {
                    activeTurn:
                      mode === "active"
                        ? { turnId: "active-native", commandId: "submit-active" }
                        : null,
                    queuedTurns:
                      mode === "queued"
                        ? [{ turnId: "queued-native", commandId: "submit-queued" }]
                        : [],
                  },
                },
              },
            };
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* host.adapter({ bindings });
          const session = yield* adapter.startSession(startInput);
          expect(session.status).toBe(mode === "idle" ? "ready" : "running");
          expect(session.activeTurnId).toBe(mode === "active" ? "active-native" : undefined);
          if (mode === "queued") {
            yield* adapter.interruptTurn(threadId, "queued-native" as never);
            expect(host.calls.at(-1)?.method).toBe("turn/unqueue");
          }
          yield* adapter.stopAll();
        }),
      );
    },
  );
  it("buffers an immediate resume approval and ordered lifecycle notifications until state is owned", async () => {
    const host = makeMuseTestHost();
    const original = host.transport.command;
    let receipt: Promise<Record<string, unknown>> | undefined;
    host.transport.command = async (method, params, cid) => {
      const raw = await original(method, params, cid);
      if (method === "session/resume") {
        receipt = host.request({ method: "approval/request", params: approvalParams("native") });
        host.emit({ method: "turn/started", params: { sessionId: "native", turnId: "turn" } });
        host.emit({
          method: "turn/completed",
          params: { sessionId: "native", turnId: "turn", terminal: "completed" },
        });
      }
      return raw;
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* host.adapter({ bindings });
        const session = yield* adapter.startSession(startInput);
        yield* Effect.promise(() => receipt!);
        expect(session.status).toBe("ready");
        expect(session.activeTurnId).toBeUndefined();
        yield* adapter.respondToRequest(threadId, "approval:0" as never, "accept");
        expect(host.calls.at(-1)?.method).toBe("approval/decide");
        yield* adapter.stopAll();
      }),
    );
  });
});
