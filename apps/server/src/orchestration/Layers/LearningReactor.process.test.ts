import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAdapterRequestError, ProviderValidationError } from "../../provider/Errors.ts";
import { processorFixture } from "./LearningReactor.process.test.helpers.ts";

const resolveSkillContext = vi.hoisted(() =>
  vi.fn<
    () => Effect.Effect<null | {
      context: { path: string; content: string; sameProviderExamples: [] };
    }>
  >(() => Effect.succeed(null)),
);
vi.mock("./LearningReactor.skill.ts", () => ({
  makeResolveSkillContext: () => resolveSkillContext,
}));

afterEach(() => {
  vi.useRealTimers();
  resolveSkillContext.mockReset();
  resolveSkillContext.mockImplementation(() => Effect.succeed(null));
});

describe("LearningReactor processor", () => {
  it("claims first, reads persisted source with a cold engine, and holds the lease through writes", async () => {
    const f = processorFixture();
    await f.run();
    expect(f.operations).toEqual(["claim", "acquire", "review", "write", "release"]);
    expect(f.getReadModel).not.toHaveBeenCalled();
    expect(f.getReviewMessages).toHaveBeenCalledWith({
      threadId: f.job.threadId,
      turnId: f.job.turnId,
    });
    expect(f.runBackgroundReview).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.stringContaining("Persisted durable preference") }),
    );
    expect(f.setState).toHaveBeenCalledWith(
      expect.objectContaining({ state: "completed", nextAttemptAt: null, outcome: "updated" }),
    );
    expect(f.dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        activity: expect.objectContaining({
          kind: "learning.memory.started",
          payload: expect.objectContaining({
            jobId: f.job.jobId,
            attempt: f.job.attemptCount,
            expiresAt: expect.any(String),
          }),
        }),
      }),
    );
    expect(f.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activity: expect.objectContaining({
          kind: "learning.memory.updated",
          payload: expect.objectContaining({ jobId: f.job.jobId, attempt: f.job.attemptCount }),
        }),
      }),
    );
  });

  it("does nothing when another worker owns the claim", async () => {
    const f = processorFixture();
    f.claim.mockImplementation(() => Effect.succeed(null));
    await f.run();
    expect(f.acquireLease).not.toHaveBeenCalled();
    expect(f.runBackgroundReview).not.toHaveBeenCalled();
    expect(f.setState).not.toHaveBeenCalled();
  });

  it("does not publish memory lifecycle activities for skill-only work", async () => {
    const f = processorFixture(1, null);
    await f.run();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("does not publish memory lifecycle activities for skill-only failures", async () => {
    const f = processorFixture(1, null);
    f.runBackgroundReview.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "review",
          detail: "offline",
        }),
      ),
    );
    await f.run();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    [1, 30_000],
    [2, 120_000],
    [3, null],
  ] as const)(
    "persists retry delay and respects the attempt budget at attempt %i",
    async (attempt, delay) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
      const f = processorFixture(attempt);
      f.runBackgroundReview.mockImplementation(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "review",
            detail: "offline",
          }),
        ),
      );
      await f.run();
      expect(f.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          state: delay === null ? "failed" : "queued",
          nextAttemptAt: delay === null ? null : new Date(Date.now() + delay).toISOString(),
          outcome: delay === null ? "failed" : "retrying",
        }),
      );
      expect(f.releaseLease).toHaveBeenCalledOnce();
      expect(f.write).not.toHaveBeenCalled();
    },
  );

  it("publishes rejected output distinctly and never writes it", async () => {
    const f = processorFixture();
    f.runBackgroundReview.mockImplementation(() => Effect.succeed("invalid JSON"));
    await f.run();
    expect(f.setState).toHaveBeenCalledWith(expect.objectContaining({ outcome: "rejected" }));
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        activity: expect.objectContaining({ kind: "learning.memory.rejected" }),
      }),
    );
    expect(f.write).not.toHaveBeenCalled();
  });

  it.each([
    "lease denied",
    "missing thread",
    "deleted thread",
    "deleting thread",
    "missing source",
  ])("does not call a provider for %s", async (scenario) => {
    const f = processorFixture();
    if (scenario === "lease denied") f.acquireLease.mockImplementation(() => Effect.succeed(false));
    if (scenario === "missing thread")
      f.getThreadOperationalState.mockImplementation(() => Effect.succeed(Option.none()));
    if (scenario === "deleted thread")
      Object.assign(f.thread, { deletedAt: "2026-09-13T00:00:00.000Z" });
    if (scenario === "deleting thread")
      Object.assign(f.thread, { deletingAt: "2026-09-13T00:00:00.000Z" });
    if (scenario === "missing source")
      f.getReviewMessages.mockImplementation(() => Effect.succeed([]));
    await f.run();
    expect(f.runBackgroundReview).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it("reuses a deterministic skill proposal when the same job is replayed", async () => {
    const f = processorFixture();
    const patch = {
      oldText: "Original detail",
      newText: "Improved detail",
      reason: "Confirmed correction",
    };
    resolveSkillContext.mockImplementation(() =>
      Effect.succeed({
        context: {
          path: "/skills/example/SKILL.md",
          content: "# Instructions\nOriginal detail\nOther detail",
          sameProviderExamples: [],
        },
      }),
    );
    f.runBackgroundReview.mockImplementation(() =>
      Effect.succeed(
        JSON.stringify({
          userMemory: null,
          globalMemory: null,
          projectMemory: null,
          skillPatch: patch,
        }),
      ),
    );
    await f.run();
    const proposal = f.proposals.create.mock.calls[0]?.[0];
    expect(proposal).toMatchObject({ threadId: f.job.threadId, status: "pending", ...patch });
    f.proposals.getById.mockImplementation(() => Effect.succeed(Option.some(proposal!)));
    await f.run();
    expect(f.proposals.create).toHaveBeenCalledOnce();
    expect(f.proposals.getById.mock.calls.map(([id]) => id)).toEqual([
      proposal!.proposalId,
      proposal!.proposalId,
    ]);
    expect(f.write).not.toHaveBeenCalled();
  });
  it("retains the owner lease and stops retries when provider cleanup cannot be confirmed", async () => {
    const f = processorFixture();
    f.runBackgroundReview.mockImplementation(() =>
      Effect.fail(
        new ProviderValidationError({
          operation: "ProviderService.runBackgroundReview.cleanup",
          issue: "Provider session could not stop",
        }),
      ),
    );
    await f.run();
    expect(f.releaseLease).not.toHaveBeenCalled();
    expect(f.setState).toHaveBeenCalledWith(
      expect.objectContaining({ state: "failed", nextAttemptAt: null }),
    );
    expect(f.write).not.toHaveBeenCalled();
  });
});
