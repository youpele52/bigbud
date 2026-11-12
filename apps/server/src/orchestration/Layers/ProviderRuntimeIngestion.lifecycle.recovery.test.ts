import type { OrchestrationThread, ProviderRuntimeEvent } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { isProvenSettledRecoveryTerminal } from "./ProviderRuntimeIngestion.lifecycle.ts";

function thread(input: {
  latestState?: string;
  terminalOutcome?: "completed" | "failed";
  latestTurnId?: string;
  activeTurnId?: string | null;
}): OrchestrationThread {
  return {
    id: "thread-1",
    latestTurn: input.latestTurnId
      ? {
          turnId: input.latestTurnId,
          state: input.latestState ?? "completed",
          requestedAt: "2026-10-29T00:00:00.000Z",
          startedAt: "2026-10-29T00:00:00.000Z",
          completedAt: "2026-10-29T00:01:00.000Z",
          assistantMessageId: null,
          ...(input.terminalOutcome ? { terminalOutcome: input.terminalOutcome } : {}),
        }
      : null,
    session: { activeTurnId: input.activeTurnId ?? null },
  } as unknown as OrchestrationThread;
}

function recoveryEvent(turnId = "turn-1"): ProviderRuntimeEvent {
  return {
    eventId: `muse-recovery-terminal-${turnId}`,
    provider: "muse",
    threadId: "thread-1",
    turnId,
    createdAt: "2026-10-29T00:02:00.000Z",
    type: "turn.completed",
    payload: { state: "completed", recoveryRedelivery: true },
  } as unknown as ProviderRuntimeEvent;
}

describe("isProvenSettledRecoveryTerminal", () => {
  it("proves settlement after canonical application (crash after application, before recovery ack)", () => {
    expect(
      isProvenSettledRecoveryTerminal(
        recoveryEvent(),
        thread({ latestTurnId: "turn-1", terminalOutcome: "completed" }),
      ),
    ).toBe(true);
  });

  it("does not treat legacy inferred completion as native settlement", () => {
    expect(
      isProvenSettledRecoveryTerminal(recoveryEvent(), thread({ latestTurnId: "turn-1" })),
    ).toBe(false);
  });

  it("does not prove settlement while the canonical turn is still running (claim/publication crash windows)", () => {
    expect(
      isProvenSettledRecoveryTerminal(
        recoveryEvent(),
        thread({ latestTurnId: "turn-1", latestState: "running", activeTurnId: "turn-1" }),
      ),
    ).toBe(false);
  });

  it("does not prove settlement for failed-before-start registration (no matching settled latest turn)", () => {
    expect(isProvenSettledRecoveryTerminal(recoveryEvent(), thread({}))).toBe(false);
    expect(
      isProvenSettledRecoveryTerminal(
        recoveryEvent(),
        thread({ latestTurnId: "turn-1", latestState: "running", activeTurnId: null }),
      ),
    ).toBe(false);
  });

  it("does not prove settlement when a different turn is canonical latest (reclaimed-queued/successor cases fall through)", () => {
    expect(
      isProvenSettledRecoveryTerminal(recoveryEvent(), thread({ latestTurnId: "turn-2" })),
    ).toBe(false);
  });

  it("ignores unflagged terminal events entirely", () => {
    const plain = {
      ...recoveryEvent(),
      payload: { state: "completed" },
    } as unknown as ProviderRuntimeEvent;
    expect(isProvenSettledRecoveryTerminal(plain, thread({ latestTurnId: "turn-1" }))).toBe(false);
  });
});
