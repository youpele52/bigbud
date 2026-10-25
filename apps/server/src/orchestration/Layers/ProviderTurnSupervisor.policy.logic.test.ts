import { MessageId, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadRecoveryIntent } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import {
  decideRecovery,
  isProgressAfterWake,
  RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS,
  type RecoveryFacts,
  sameThreadRecovery,
  toThreadRecovery,
} from "./ProviderTurnSupervisor.policy.logic.ts";

const WOKE = 1_761_140_000_000;

function intent(overrides: Partial<ThreadRecoveryIntent> = {}): ThreadRecoveryIntent {
  return {
    threadId: ThreadId.makeUnsafe("t"),
    messageId: MessageId.makeUnsafe("m"),
    provider: "claudeAgent",
    turnId: TurnId.makeUnsafe("turn"),
    disposition: "active",
    recoveryStatus: "interrupted-by-sleep",
    detail: { reason: "interrupted-by-sleep" },
    attemptCount: 0,
    lastAttemptAt: null,
    continuationMessageId: null,
    revision: 1,
    createdAt: new Date(WOKE - 600_000).toISOString(),
    updatedAt: new Date(WOKE).toISOString(),
    ...overrides,
  };
}

function facts(overrides: Partial<RecoveryFacts> = {}): RecoveryFacts {
  return {
    intent: intent(),
    nowMs: WOKE + 2_000,
    wokeAtMs: WOKE,
    inspection: "unavailable",
    progressAfterWake: false,
    lastProgressAtMs: null,
    turnCompleted: false,
    toolInFlight: null,
    networkOnline: true,
    continuationEnabled: true,
    threadIdle: true,
    waitingForUser: false,
    ...overrides,
  };
}

describe("decideRecovery for a turn cut by sleep", () => {
  it("continues once when the model request was cut and no tool was in flight", () => {
    expect(decideRecovery(facts())).toEqual({ type: "continue" });
  });

  it("asks, naming the tool, when a tool may have been running", () => {
    expect(decideRecovery(facts({ toolInFlight: "Run tests" }))).toEqual({
      type: "await-user",
      reason: "tool-in-flight",
      toolSummary: "Run tests",
    });
  });

  it("observes a provider that continued on its own", () => {
    expect(decideRecovery(facts({ progressAfterWake: true }))).toEqual({
      type: "provider-continued",
    });
    expect(decideRecovery(facts({ inspection: "running" }))).toEqual({
      type: "provider-continued",
    });
  });

  it("settles a turn that finished", () => {
    expect(decideRecovery(facts({ turnCompleted: true }))).toEqual({ type: "settle" });
    expect(decideRecovery(facts({ inspection: "completed" }))).toEqual({ type: "settle" });
  });

  it("waits for the network without counting an attempt", () => {
    expect(decideRecovery(facts({ networkOnline: false }))).toEqual({ type: "wait-network" });
    // Unknown network state (no desktop hints) is treated as online.
    expect(decideRecovery(facts({ networkOnline: null }))).toEqual({ type: "continue" });
  });

  it("does not wait for the network forever: it asks after the awake-time limit", () => {
    const offline = { networkOnline: false, nowMs: WOKE + RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS - 1 };
    expect(decideRecovery(facts(offline))).toEqual({ type: "wait-network" });
    expect(
      decideRecovery(facts({ ...offline, nowMs: WOKE + RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS })),
    ).toEqual({ type: "await-user", reason: "interrupted-by-sleep", toolSummary: null });
  });

  it("parks after three failed automatic attempts", () => {
    expect(decideRecovery(facts({ intent: intent({ attemptCount: 3 }) }))).toEqual({
      type: "park",
    });
  });

  it("with the kill switch, prompts instead of sending", () => {
    expect(decideRecovery(facts({ continuationEnabled: false }))).toEqual({
      type: "await-user",
      reason: "interrupted-by-sleep",
      toolSummary: null,
    });
  });

  it("lets a user-authorized continuation through a tool prompt and the park limit", () => {
    const authorized = intent({ attemptCount: 3, detail: { userAuthorized: true } });
    expect(decideRecovery(facts({ intent: authorized, toolInFlight: "Edit" }))).toEqual({
      type: "continue",
    });
  });

  it("waits while the thread is busy, then prompts after the awake-time limit", () => {
    expect(decideRecovery(facts({ threadIdle: false }))).toEqual({ type: "none" });
    expect(
      decideRecovery(
        facts({ threadIdle: false, nowMs: WOKE + RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS }),
      ),
    ).toMatchObject({ type: "await-user", reason: "interrupted-by-sleep" });
  });

  it("never acts on a revoked or suspended intent", () => {
    for (const disposition of ["revoked", "suspended-for-exit", "settled"] as const) {
      expect(decideRecovery(facts({ intent: intent({ disposition }) }))).toEqual({ type: "none" });
    }
  });
});

describe("decideRecovery for a turn running across the sleep", () => {
  const observing = intent({ recoveryStatus: "observing", detail: {} });

  it("waits quietly, then reports no activity after 120 s of awake time", () => {
    expect(decideRecovery(facts({ intent: observing }))).toEqual({ type: "none" });
    expect(
      decideRecovery(
        facts({
          intent: observing,
          nowMs: WOKE + RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS,
          toolInFlight: "Bash",
        }),
      ),
    ).toEqual({ type: "await-user", reason: "no-activity-after-wake", toolSummary: "Bash" });
  });

  it("observes an OpenCode V2 turn that inspection reports running", () => {
    expect(decideRecovery(facts({ intent: observing, inspection: "running" }))).toEqual({
      type: "provider-continued",
    });
  });

  it("treats a pending approval or answer as the provider still working, not silence", () => {
    const late = { intent: observing, nowMs: WOKE + RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS * 2 };
    expect(decideRecovery(facts({ ...late, waitingForUser: true, threadIdle: false }))).toEqual({
      type: "provider-continued",
    });
  });
});

describe("decideRecovery for a provider that continued on its own", () => {
  const continued = intent({ recoveryStatus: "provider-continued", detail: {} });
  const quiet = WOKE + RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS;

  it("asks, and never sends, once an idle thread stayed quiet for 120 s", () => {
    expect(decideRecovery(facts({ intent: continued, nowMs: quiet - 1 }))).toEqual({
      type: "none",
    });
    expect(decideRecovery(facts({ intent: continued, nowMs: quiet }))).toEqual({
      type: "await-user",
      reason: "interrupted-by-sleep",
      toolSummary: null,
    });
  });

  it("counts the quiet time from the latest progress, not only from wake", () => {
    const progressed = { intent: continued, lastProgressAtMs: WOKE + 60_000 };
    expect(decideRecovery(facts({ ...progressed, nowMs: quiet }))).toEqual({ type: "none" });
    expect(decideRecovery(facts({ ...progressed, nowMs: quiet + 60_000 }))).toMatchObject({
      type: "await-user",
    });
  });

  it("keeps waiting while the thread is busy or inspection says it runs, and settles a finish", () => {
    const late = { intent: continued, nowMs: quiet * 2 };
    expect(decideRecovery(facts({ ...late, threadIdle: false }))).toEqual({ type: "none" });
    expect(decideRecovery(facts({ ...late, inspection: "running" }))).toEqual({ type: "none" });
    expect(decideRecovery(facts({ ...late, turnCompleted: true }))).toEqual({ type: "settle" });
  });
});

describe("recovery helpers", () => {
  it("ignores progress buffered right at wake", () => {
    expect(isProgressAfterWake(WOKE + 1_000, WOKE)).toBe(false);
    expect(isProgressAfterWake(WOKE + 3_000, WOKE)).toBe(true);
    expect(isProgressAfterWake(null, WOKE)).toBe(false);
  });

  it("projects only visible statuses and compares them without timestamps", () => {
    expect(toThreadRecovery(intent({ recoveryStatus: "observing" }), "x")).toBeNull();
    const shown = toThreadRecovery(intent({ recoveryStatus: "awaiting-user" }), "a");
    expect(shown).toMatchObject({ status: "awaiting-user", messageId: "m", attempt: 0 });
    expect(sameThreadRecovery(shown, { ...shown!, updatedAt: "b" })).toBe(true);
    expect(sameThreadRecovery(null, null)).toBe(true);
    expect(sameThreadRecovery(shown, null)).toBe(false);
  });
});
