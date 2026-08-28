import { describe, expect, it } from "vitest";

import { buildThreadBootstrap } from "./ChatView.sendTurn.helpers";

describe("buildThreadBootstrap", () => {
  it("derives retry-stable worktree identity from the persisted command id", () => {
    const input = {
      thread: {
        id: "thread-1",
        title: "Draft",
        branch: "main",
        worktreePath: null,
        createdAt: "2026-08-27T00:00:00.000Z",
      },
      project: { id: "project-1", cwd: "/repo" },
      isDraft: true,
      isFirstMessage: true,
      promptText: "Fix recovery",
      modelSelection: { provider: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      baseBranchForWorktree: "main",
      recoveryCommandId: "command-stable-retry",
    } as const;

    const first = buildThreadBootstrap(input as never);
    const retry = buildThreadBootstrap(input as never);
    const other = buildThreadBootstrap({
      ...input,
      recoveryCommandId: "command-different-retry",
    } as never);

    expect(retry).toEqual(first);
    expect(retry?.prepareWorktree?.branch).toBe(first?.prepareWorktree?.branch);
    expect(other?.prepareWorktree?.branch).not.toBe(first?.prepareWorktree?.branch);
  });
});
