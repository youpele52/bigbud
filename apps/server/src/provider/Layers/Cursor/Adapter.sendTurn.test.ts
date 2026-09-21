import { EventId, ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { createFakeAcpSessionRuntime } from "../../acp/AcpSessionRuntime.test.helpers.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import type { CursorSessionContext } from "./Adapter.helpers.ts";
import { makeSendTurnEffect } from "./Adapter.sendTurn.ts";
import { vi } from "vitest";

const THREAD_ID = ThreadId.makeUnsafe("thread-cursor-send-turn");
const NOW = "2026-09-21T00:00:00.000Z";

function makeContext(): CursorSessionContext {
  return {
    threadId: THREAD_ID,
    sessionEpoch: 3,
    session: {
      provider: "cursor",
      status: "ready",
      runtimeMode: "full-access",
      threadId: THREAD_ID,
      sessionEpoch: 3,
      createdAt: NOW,
      updatedAt: NOW,
    },
    scope: {} as CursorSessionContext["scope"],
    acp: createFakeAcpSessionRuntime(),
    notificationFiber: undefined,
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    turns: [],
    lastPlanFingerprint: undefined,
    activeTurnId: undefined,
    stopped: false,
  };
}

function sendTurnDeps(ctx: CursorSessionContext, events: ProviderRuntimeEvent[]) {
  return {
    fileSystem: { readFile: () => Effect.die("unused") } as never,
    attachmentsDir: "/tmp",
    nowIso: Effect.succeed(NOW),
    makeEventStamp: () =>
      Effect.succeed({
        eventId: EventId.makeUnsafe(`evt-${events.length + 1}`),
        createdAt: NOW,
      }),
    offerRuntimeEvent: (event: ProviderRuntimeEvent) =>
      Effect.sync(() => {
        events.push(event);
      }),
    requireSession: () => Effect.succeed(ctx),
  };
}

describe("CursorAdapter sendTurn lifecycle", () => {
  it.effect(
    "clears the live turn after ACP prompt completion so follow-ups can auto-dispatch",
    () =>
      Effect.gen(function* () {
        const ctx = makeContext();
        const events: ProviderRuntimeEvent[] = [];
        const result = yield* makeSendTurnEffect(sendTurnDeps(ctx, events), {
          threadId: THREAD_ID,
          input: "second message",
          attachments: [],
        });

        assert.equal(ctx.activeTurnId, undefined);
        assert.equal(ctx.session.status, "ready");
        assert.equal(ctx.session.activeTurnId, undefined);
        assert.equal(events.map((event) => event.type).join(","), "turn.started,turn.completed");
        assert.equal(events.at(-1)?.turnId, result.turnId);
      }),
  );

  it.effect("does not mark the session live when the turn is rejected before prompt", () =>
    Effect.gen(function* () {
      const ctx = makeContext();
      const events: ProviderRuntimeEvent[] = [];
      const error = yield* Effect.flip(
        makeSendTurnEffect(sendTurnDeps(ctx, events), {
          threadId: THREAD_ID,
          input: "   ",
          attachments: [],
        }),
      );

      assert.instanceOf(error, ProviderAdapterValidationError);
      assert.equal(ctx.activeTurnId, undefined);
      assert.equal(ctx.session.status, "ready");
      assert.equal(events.length, 0);
    }),
  );

  it.effect("clears the live turn when ACP prompt fails", () =>
    Effect.gen(function* () {
      const ctx = makeContext();
      vi.mocked(ctx.acp.prompt).mockReturnValue(Effect.fail(new Error("prompt failed")) as never);
      const events: ProviderRuntimeEvent[] = [];
      yield* Effect.flip(
        makeSendTurnEffect(sendTurnDeps(ctx, events), {
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        }),
      );

      assert.equal(ctx.activeTurnId, undefined);
      assert.equal(ctx.session.status, "ready");
      assert.equal(ctx.session.activeTurnId, undefined);
    }),
  );
});
