import { TurnId } from "@bigbud/contracts/core/baseSchemas";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeMuseTestHost, startInput, threadId } from "./Adapter.failures.test.helpers.ts";

describe("Muse authoritative inspection", () => {
  it.each([
    [{}, "unavailable"],
    [{ session: { sessionId: "wrong", activeTurnId: null } }, "unavailable"],
    [{ session: { sessionId: "cmd-1" } }, "unavailable"],
    [{ session: { sessionId: "cmd-1", activeTurnId: null } }, "missing"],
    [{ session: { sessionId: "cmd-1", activeTurnId: "target" } }, "running"],
    [
      {
        session: { sessionId: "cmd-1", activeTurnId: null },
        lastTurn: { turnId: "target", terminal: "failed" },
      },
      "failed",
    ],
    [
      {
        session: { sessionId: "cmd-1", activeTurnId: null },
        lastTurn: { turnId: "target", terminal: "completed" },
      },
      "completed",
    ],
    [
      {
        session: { sessionId: "cmd-1", activeTurnId: null },
        lastTurn: { turnId: "target", terminal: "new-terminal" },
      },
      "failed",
    ],
    [
      {
        session: { sessionId: "cmd-1", activeTurnId: null },
        queuedInputs: [{ sequence: 1, text: "queued" }],
      },
      "unavailable",
    ],
    [
      {
        session: { sessionId: "cmd-1", activeTurnId: null },
        queuedInputs: [{ sequence: 1, text: "queued", sourceCommandId: "target" }],
      },
      "unavailable",
    ],
    [
      {
        session: { sessionId: "cmd-1", activeTurnId: null },
        viewCursor: "v",
        history: {
          mode: "snapshot",
          snapshot: {
            viewCursor: "v",
            state: { activeTurn: null, queuedTurns: [{ turnId: "target", commandId: "submit" }] },
          },
        },
      },
      "running",
    ],
  ] as const)("uses native evidence, never inferred idle success: %j", async (read, expected) => {
    const host = makeMuseTestHost();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* host.adapter();
        yield* adapter.startSession(startInput);
        host.transport.request = async () => read;
        const inspection = yield* adapter.inspectActiveTurn(threadId, TurnId.makeUnsafe("target"));
        expect(inspection.status).toBe(expected);
        if (expected === "failed")
          expect(inspection.errorEvidence?.source).toBe("muse.session/read.lastTurn");
        yield* adapter.stopAll();
      }),
    );
  });
  it("reports transport errors as unavailable", async () => {
    const host = makeMuseTestHost();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* host.adapter();
        yield* adapter.startSession(startInput);
        host.transport.request = async () => {
          throw { detail: "lost" };
        };
        expect(
          (yield* adapter.inspectActiveTurn(threadId, TurnId.makeUnsafe("target"))).status,
        ).toBe("unavailable");
      }),
    );
  });
});
