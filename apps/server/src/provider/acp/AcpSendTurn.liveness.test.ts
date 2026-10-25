import { EventId, ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";
import { describe, expect, it } from "vitest";

import { classifyTurnStartFailure } from "../../orchestration/Layers/ProviderTurnFailureClassification.ts";
import { makeSendTurnEffect as makeCursorSendTurn } from "../Layers/Cursor/Adapter.sendTurn.ts";
import { makeSendTurnEffect as makeDevinSendTurn } from "../Layers/Devin/Adapter.sendTurn.ts";
import { createFakeAcpSessionRuntime } from "./AcpSessionRuntime.test.helpers.ts";

const NOW = "2026-10-15T10:00:00.000Z";
const ADAPTERS = [
  ["cursor", makeCursorSendTurn],
  ["devin", makeDevinSendTurn],
] as const;

function harness(provider: "cursor" | "devin", alive: boolean) {
  const threadId = ThreadId.makeUnsafe(`thread-${provider}-liveness`);
  const acp = {
    ...createFakeAcpSessionRuntime(),
    isAlive: Effect.succeed(alive),
    prompt: () => Effect.fail(new EffectAcpErrors.AcpProcessExitedError({ code: 1 })),
  };
  const ctx = {
    threadId,
    sessionEpoch: 1,
    session: {
      provider,
      status: "ready",
      runtimeMode: "full-access",
      threadId,
      sessionEpoch: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    scope: {},
    acp,
    notificationFiber: undefined,
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    turns: [],
    lastPlanFingerprint: undefined,
    activeTurnId: undefined,
    stopped: false,
  } as never;
  const events: ProviderRuntimeEvent[] = [];
  const deps = {
    fileSystem: { readFile: () => Effect.die("unused") } as never,
    attachmentsDir: "/tmp",
    nowIso: Effect.succeed(NOW),
    makeEventStamp: () =>
      Effect.succeed({ eventId: EventId.makeUnsafe(`evt-${events.length + 1}`), createdAt: NOW }),
    offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.sync(() => void events.push(event)),
    requireSession: () => Effect.succeed(ctx),
  };
  return { threadId, deps, events };
}

describe("ACP turn start when the agent process already exited", () => {
  it.each(ADAPTERS)(
    "%s: an exit observed before dispatch is session-dead and the turn never starts",
    async (provider, makeSendTurn) => {
      const { threadId, deps, events } = harness(provider, false);
      const error = await Effect.runPromise(
        Effect.flip(makeSendTurn(deps, { threadId, input: "hello", attachments: [] })),
      );
      expect(classifyTurnStartFailure(error)).toBe("session-dead");
      expect(events.map((event) => event.type)).not.toContain("turn.started");
    },
  );

  it.each(ADAPTERS)(
    "%s: an exit observed after the prompt was dispatched stays unsafe-to-replay",
    async (provider, makeSendTurn) => {
      const { threadId, deps, events } = harness(provider, true);
      const error = await Effect.runPromise(
        Effect.flip(makeSendTurn(deps, { threadId, input: "hello", attachments: [] })),
      );
      expect(classifyTurnStartFailure(error)).toBe("unsafe-to-replay");
      expect(events.map((event) => event.type)).toContain("turn.started");
    },
  );
});
