import { CommandId, EventId, ThreadId } from "../core/baseSchemas";
import { OrchestrationEvent } from "../orchestration/orchestration.events";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  MOBILE_RECOVERY_ID_MAX_LENGTH,
  MOBILE_RECOVERY_MAX_EVENTS_PER_BATCH,
  MobileRecoveryBaselineInput,
  MobileRecoveryCommandOutcome,
  MobileRecoveryCommandOutcomeInput,
  MobileRecoveryFrame,
  MobileRecoverySubscriptionInput,
} from "./mobile.recovery";

const threadId = ThreadId.makeUnsafe("mobile-recovery-contract-thread");

function makeEvent(sequence: number) {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`mobile-recovery-contract-event-${sequence}`),
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt: "2026-09-09T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.reverted" as const,
    payload: { threadId, turnCount: sequence },
  } satisfies typeof OrchestrationEvent.Type;
}

describe("mobile recovery contracts", () => {
  it("rejects malformed and oversized recovery identities", () => {
    expect(() =>
      Schema.decodeUnknownSync(MobileRecoveryBaselineInput)({ recoveryAttemptId: "  " }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MobileRecoveryBaselineInput)({
        recoveryAttemptId: "x".repeat(MOBILE_RECOVERY_ID_MAX_LENGTH + 1),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MobileRecoverySubscriptionInput)({
        recoveryAttemptId: "attempt-1",
        serverEpoch: "x".repeat(MOBILE_RECOVERY_ID_MAX_LENGTH + 1),
        baselineSequence: 0,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MobileRecoverySubscriptionInput)({
        recoveryAttemptId: "attempt-1",
        baselineSequence: 0,
      }),
    ).toThrow();
  });

  it("applies the identity limit to JavaScript string length", () => {
    const validAttemptId = "😀".repeat(MOBILE_RECOVERY_ID_MAX_LENGTH / 2);
    const invalidAttemptId = "😀".repeat(MOBILE_RECOVERY_ID_MAX_LENGTH / 2 + 1);

    expect(
      Schema.decodeUnknownSync(MobileRecoveryBaselineInput)({
        recoveryAttemptId: validAttemptId,
      }),
    ).toMatchObject({ recoveryAttemptId: validAttemptId });
    expect(() =>
      Schema.decodeUnknownSync(MobileRecoveryBaselineInput)({
        recoveryAttemptId: invalidAttemptId,
      }),
    ).toThrow();
  });

  it("bounds event batches", () => {
    const events = Array.from({ length: MOBILE_RECOVERY_MAX_EVENTS_PER_BATCH + 1 }, (_, index) =>
      makeEvent(index),
    );

    expect(() =>
      Schema.decodeUnknownSync(MobileRecoveryFrame)({
        version: 1,
        type: "batch",
        route: "direct-unmanaged",
        recoveryAttemptId: "attempt-1",
        serverEpoch: "server-1",
        batchId: "batch-1",
        events,
      }),
    ).toThrow();
  });

  it("accepts a zero-event caught-up boundary", () => {
    expect(
      Schema.decodeUnknownSync(MobileRecoveryFrame)({
        version: 1,
        type: "caught-up",
        route: "direct-unmanaged",
        recoveryAttemptId: "attempt-1",
        serverEpoch: "server-1",
        throughSequence: 0,
      }),
    ).toMatchObject({ type: "caught-up", throughSequence: 0 });
  });

  it("bounds command outcome reads to a thread and small result", () => {
    const input = Schema.decodeUnknownSync(MobileRecoveryCommandOutcomeInput)({
      commandId: CommandId.makeUnsafe("command-1"),
      threadId,
    });
    expect(input.threadId).toBe(threadId);
    expect(
      Schema.decodeUnknownSync(MobileRecoveryCommandOutcome)({
        commandId: input.commandId,
        status: "rejected",
        resultSequence: 4,
        reason: "other",
        serverEpoch: "server-1",
        canonicalRevision: 4,
      }),
    ).toMatchObject({ status: "rejected", reason: "other" });
    const decoded = Schema.decodeUnknownSync(MobileRecoveryCommandOutcome)({
      commandId: input.commandId,
      status: "rejected",
      resultSequence: 4,
      reason: "other",
      serverEpoch: "server-1",
      canonicalRevision: 4,
      error: "raw provider error",
    });
    expect(decoded).not.toHaveProperty("error");
  });
});
