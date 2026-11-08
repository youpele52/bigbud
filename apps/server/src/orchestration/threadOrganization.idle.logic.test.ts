import { DEFAULT_THREAD_ORGANIZATION } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { describe, expect, it } from "vitest";

import { isThreadQuiescent, organizationAfterIdle } from "./threadOrganization.idle.logic.ts";

const quiet = {
  session: null,
  latestTurn: null,
  queuedPrompts: [],
  pendingTurnStart: null,
  pendingInterruptFlushIntent: null,
  pendingTurnControlOperation: null,
  queueHold: false,
  recovery: null,
} as unknown as Parameters<typeof isThreadQuiescent>[0];

describe("isThreadQuiescent", () => {
  it("accepts a thread with nothing running, queued, held, or recovering", () => {
    expect(isThreadQuiescent(quiet)).toBe(true);
    expect(isThreadQuiescent({ ...quiet, session: { status: "ready" } } as never)).toBe(true);
  });

  it.each(["completed", "failed", "superseded", "cancelled"])(
    "does not treat a retained %s turn-control operation as pending work",
    (state) => {
      expect(isThreadQuiescent({ ...quiet, pendingTurnControlOperation: { state } } as never)).toBe(
        true,
      );
    },
  );

  it.each(["requested", "provider-acknowledged", "waiting-for-settlement", "ambiguous"])(
    "still protects a %s turn-control operation",
    (state) => {
      expect(isThreadQuiescent({ ...quiet, pendingTurnControlOperation: { state } } as never)).toBe(
        false,
      );
    },
  );

  it("rejects each blocker on its own", () => {
    for (const blocker of [
      { session: { status: "running" } },
      { session: { status: "starting" } },
      { latestTurn: { state: "running" } },
      { queuedPrompts: [{ id: "m" }] },
      { pendingTurnStart: { messageId: "m" } },
      { pendingInterruptFlushIntent: { kind: "flush" } },
      { pendingTurnControlOperation: { kind: "steer" } },
      { queueHold: true },
      { recovery: { kind: "sleep" } },
    ]) {
      expect(isThreadQuiescent({ ...quiet, ...blocker } as never), JSON.stringify(blocker)).toBe(
        false,
      );
    }
  });
});

describe("organizationAfterIdle", () => {
  const occurredAt = "2026-10-30T10:00:00.000Z";
  const present = { ...DEFAULT_THREAD_ORGANIZATION, revision: 4 };

  it("moves an unchanged Present thread to the destination", () => {
    expect(
      organizationAfterIdle(present, {
        expectedRevision: 4,
        fromState: "present",
        destination: "later",
        occurredAt,
      }),
    ).toEqual({ state: "later", revision: 5, changedAt: occurredAt, snooze: null });
  });

  it("moves an unchanged, unsnoozed Later thread to Done for the older-threads rule", () => {
    const later = { ...present, state: "later" as const };
    const input = { expectedRevision: 4, fromState: "later" as const, occurredAt };
    expect(organizationAfterIdle(later, { ...input, destination: "done" })).toEqual({
      state: "done",
      revision: 5,
      changedAt: occurredAt,
      snooze: null,
    });
    expect(organizationAfterIdle(later, { ...input, destination: "later" })).toBe(null);
    expect(
      organizationAfterIdle(
        { ...later, snooze: { id: "s", until: occurredAt } },
        { ...input, destination: "done" },
      ),
    ).toBe(null);
  });

  it("loses to any change since the candidate was read", () => {
    const input = {
      expectedRevision: 4,
      fromState: "present" as const,
      destination: "done" as const,
      occurredAt,
    };
    expect(organizationAfterIdle({ ...present, state: "later" }, input)).toBe(null);
    expect(organizationAfterIdle({ ...present, revision: 5 }, input)).toBe(null);
    expect(organizationAfterIdle({ ...present, state: "needs-you" }, input)).toBe(null);
    expect(
      organizationAfterIdle({ ...present, snooze: { id: "s", until: occurredAt } }, input),
    ).toBe(null);
  });
});
