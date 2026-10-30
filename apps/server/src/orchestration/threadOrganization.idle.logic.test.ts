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
      organizationAfterIdle(present, { expectedRevision: 4, destination: "later", occurredAt }),
    ).toEqual({ state: "later", revision: 5, changedAt: occurredAt, snooze: null });
  });

  it("loses to any change since the candidate was read", () => {
    const input = { expectedRevision: 4, destination: "done" as const, occurredAt };
    expect(organizationAfterIdle({ ...present, revision: 5 }, input)).toBe(null);
    expect(organizationAfterIdle({ ...present, state: "needs-you" }, input)).toBe(null);
    expect(
      organizationAfterIdle({ ...present, snooze: { id: "s", until: occurredAt } }, input),
    ).toBe(null);
  });
});
