import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ThreadId, ProjectId, EventId } from "@bigbud/contracts";
import { runThreadAwareGitAction } from "./wsGitTextGenerationContext.ts";

function fixture(workspaceExecutionTargetId?: string) {
  const threadId = ThreadId.makeUnsafe("thread");
  const successful = { provider: "claudeAgent", model: "verified-model" };
  const thread = {
    id: threadId,
    projectId: ProjectId.makeUnsafe("project"),
    worktreePath: "/worktree",
    workspaceExecutionTargetId,
    modelSelection: { provider: "codex", model: "new-unproven-selection" },
    activities: [
      {
        id: EventId.makeUnsafe("success"),
        kind: "text-generation.model-succeeded",
        payload: successful,
      },
    ],
  };
  const runStackedAction = vi.fn(() => Effect.succeed({}));
  const context = {
    gitManager: { runStackedAction },
    orchestrationEngine: {
      getReadModel: () => Effect.succeed({ threads: [thread], projects: [] }),
    },
  } as unknown as Parameters<typeof runThreadAwareGitAction>[0];
  return { threadId, successful, runStackedAction, context };
}

describe("Git text-generation thread context", () => {
  it.each([
    [undefined, undefined, true],
    ["local", undefined, true],
    ["ssh:a", "ssh:a", true],
    ["ssh:a", "ssh:b", false],
    ["ssh:a", undefined, false],
    ["local", "ssh:a", false],
  ] as const)(
    "requires canonical execution-target equality (%s / %s)",
    async (threadTarget, actionTarget, matches) => {
      const test = fixture(threadTarget);
      await Effect.runPromise(
        runThreadAwareGitAction(
          test.context,
          {
            cwd: "/worktree",
            action: "commit",
            actionId: "action",
            threadId: test.threadId,
            ...(actionTarget ? { executionTargetId: actionTarget } : {}),
          },
          {},
        ),
      );
      expect(test.runStackedAction).toHaveBeenCalledWith(expect.anything(), {
        successfulModelSelection: matches ? test.successful : null,
      });
    },
  );
  it("passes server-verified success for the explicitly associated workspace", async () => {
    const test = fixture();
    await Effect.runPromise(
      runThreadAwareGitAction(
        test.context,
        { cwd: "/worktree", action: "commit", actionId: "action", threadId: test.threadId },
        {},
      ),
    );
    expect(test.runStackedAction).toHaveBeenCalledWith(expect.anything(), {
      successfulModelSelection: test.successful,
    });
  });
  it.each(["/unrelated", "/worktree"])(
    "does not infer association from cwd %s alone",
    async (cwd) => {
      const test = fixture();
      await Effect.runPromise(
        runThreadAwareGitAction(test.context, { cwd, action: "commit", actionId: "action" }, {}),
      );
      expect(test.runStackedAction).toHaveBeenCalledWith(expect.anything(), {
        successfulModelSelection: null,
      });
    },
  );
  it("does not use a different workspace's thread model", async () => {
    const test = fixture();
    await Effect.runPromise(
      runThreadAwareGitAction(
        test.context,
        { cwd: "/unrelated", action: "commit", actionId: "action", threadId: test.threadId },
        {},
      ),
    );
    expect(test.runStackedAction).toHaveBeenCalledWith(expect.anything(), {
      successfulModelSelection: null,
    });
  });
});
