import { describe, expect, it } from "vitest";

import { makeActivity } from "~/logic/session/session.logic.test.helpers";

import {
  deriveMemoryReviewAttempt,
  shouldShowMemoryReviewStatus,
} from "./memoryReviewStatus.logic";

const start = (overrides: Record<string, unknown> = {}) =>
  makeActivity({
    id: "memory-start",
    sequence: 1,
    createdAt: "2026-09-13T12:00:00.000Z",
    kind: "learning.memory.started",
    tone: "info",
    summary: "Reviewing memory",
    payload: {
      jobId: "learning:thread:turn",
      attempt: 1,
      expiresAt: "2026-09-13T12:04:00.000Z",
      ...overrides,
    },
  });

const ending = (kind = "learning.memory.updated") =>
  makeActivity({
    id: `memory-${kind}`,
    sequence: 2,
    createdAt: "2026-09-13T12:01:00.000Z",
    kind,
    tone: kind === "learning.memory.failed" ? "error" : "info",
    summary: "Memory review finished",
    payload: { jobId: "learning:thread:turn", attempt: 1 },
  });

describe("deriveMemoryReviewAttempt", () => {
  it("returns an active unexpired attempt", () => {
    expect(deriveMemoryReviewAttempt([start()], Date.parse("2026-09-13T12:02:00.000Z"))).toEqual({
      jobId: "learning:thread:turn",
      attempt: 1,
      expiresAt: "2026-09-13T12:04:00.000Z",
      startedAt: "2026-09-13T12:00:00.000Z",
    });
  });

  it.each(["updated", "unchanged", "retrying", "rejected", "failed", "interrupted"])(
    "clears an attempt after %s",
    (outcome) => {
      expect(
        deriveMemoryReviewAttempt(
          [start(), ending(`learning.memory.${outcome}`)],
          Date.parse("2026-09-13T12:02:00.000Z"),
        ),
      ).toBeNull();
    },
  );

  it("does not resurrect a settled attempt from duplicate or out-of-order events", () => {
    const settled = ending();
    expect(
      deriveMemoryReviewAttempt(
        [
          { ...settled, sequence: 1 },
          { ...start({ expiresAt: "2026-09-13T12:03:00.000Z" }), sequence: 2 },
        ],
        Date.parse("2026-09-13T12:02:00.000Z"),
      ),
    ).toBeNull();
  });

  it("ignores malformed, legacy, and expired starts", () => {
    expect(
      deriveMemoryReviewAttempt(
        [
          start({ jobId: "", attempt: 1 }),
          start({ attempt: 0 }),
          start({ expiresAt: "2026-09-13T11:59:00.000Z" }),
          makeActivity({ kind: "learning.memory.updated", payload: { attempt: 1 } }),
        ],
        Date.parse("2026-09-13T12:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("keeps separate attempts independent", () => {
    const second = makeActivity({
      id: "memory-start-2",
      sequence: 3,
      createdAt: "2026-09-13T12:02:00.000Z",
      kind: "learning.memory.started",
      tone: "info",
      summary: "Reviewing memory",
      payload: {
        jobId: "learning:thread:other-turn",
        attempt: 1,
        expiresAt: "2026-09-13T12:05:00.000Z",
      },
    });
    expect(
      deriveMemoryReviewAttempt(
        [start(), ending(), second],
        Date.parse("2026-09-13T12:03:00.000Z"),
      ),
    ).toMatchObject({ jobId: "learning:thread:other-turn", attempt: 1 });
  });
});

describe("shouldShowMemoryReviewStatus", () => {
  const active = {
    memoryReviewing: true,
    isWorking: false,
    isCompacting: false,
    hasPendingApproval: false,
    hasPendingUserInput: false,
    hasUnconfirmedProvider: false,
  } as const;

  it("reveals memory work only after foreground work and interactions settle", () => {
    expect(shouldShowMemoryReviewStatus(active)).toBe(true);
    expect(shouldShowMemoryReviewStatus({ ...active, isWorking: true })).toBe(false);
    expect(shouldShowMemoryReviewStatus({ ...active, isCompacting: true })).toBe(false);
    expect(shouldShowMemoryReviewStatus({ ...active, hasPendingApproval: true })).toBe(false);
    expect(shouldShowMemoryReviewStatus({ ...active, hasPendingUserInput: true })).toBe(false);
    expect(shouldShowMemoryReviewStatus({ ...active, hasUnconfirmedProvider: true })).toBe(false);
    expect(shouldShowMemoryReviewStatus({ ...active, memoryReviewing: false })).toBe(false);
  });
});
