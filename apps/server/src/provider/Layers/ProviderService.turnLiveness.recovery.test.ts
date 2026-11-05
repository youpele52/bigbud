import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderTurnLivenessRepositoryShape } from "../../persistence/Services/ProviderTurnLiveness.ts";
import { observeProviderRuntimeEvent } from "./ProviderService.turnLiveness.ts";

function fakeLiveness(claimResults: Array<boolean>) {
  let index = 0;
  const repo = {
    startTurn: () => Effect.void,
    observeEvent: () => Effect.void,
    recordInspection: () => Effect.void,
    markTerminal: () => Effect.void,
    claimTerminal: () => Effect.succeed(claimResults[index++] ?? false),
    markMonitoringLost: () => Effect.void,
    listActive: () => Effect.succeed([]),
  } satisfies ProviderTurnLivenessRepositoryShape;
  return Option.some(repo);
}

function terminalEvent(input: {
  provider: string;
  eventId: string;
  recovery?: boolean;
}): ProviderRuntimeEvent {
  return {
    eventId: input.eventId,
    provider: input.provider,
    threadId: ThreadId.makeUnsafe("thread-1"),
    turnId: TurnId.makeUnsafe("turn-1"),
    createdAt: "2026-10-29T00:00:00.000Z",
    type: "turn.completed",
    payload: {
      state: "completed",
      ...(input.recovery ? { recoveryRedelivery: true } : {}),
    },
  } as ProviderRuntimeEvent;
}

describe("terminal liveness claim and recovery redelivery (Phase 3.15)", () => {
  it("keeps claim suppression for ordinary duplicate terminal events (all providers unchanged)", async () => {
    const shouldPublish = await Effect.runPromise(
      observeProviderRuntimeEvent(
        fakeLiveness([false]),
        terminalEvent({ provider: "codex", eventId: "evt-original" }),
      ),
    );
    expect(shouldPublish).toBe(false);
  });

  it("publishes a first terminal claim normally", async () => {
    const shouldPublish = await Effect.runPromise(
      observeProviderRuntimeEvent(
        fakeLiveness([true]),
        terminalEvent({ provider: "muse", eventId: "evt-first" }),
      ),
    );
    expect(shouldPublish).toBe(true);
  });

  it("allows an explicitly flagged Muse recovery redelivery past an existing claim", async () => {
    const shouldPublish = await Effect.runPromise(
      observeProviderRuntimeEvent(
        fakeLiveness([false]),
        terminalEvent({
          provider: "muse",
          eventId: "muse-recovery-terminal-turn-1",
          recovery: true,
        }),
      ),
    );
    expect(shouldPublish).toBe(true);
  });

  it("does not let an unflagged Muse terminal event bypass the claim", async () => {
    const shouldPublish = await Effect.runPromise(
      observeProviderRuntimeEvent(
        fakeLiveness([false]),
        terminalEvent({ provider: "muse", eventId: "evt-duplicate" }),
      ),
    );
    expect(shouldPublish).toBe(false);
  });
});
