import type { GitStatusResult } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  buildGitSyncPrompt,
  formatGitSyncSummary,
  getGitSyncIssueOptions,
  gitSyncActionLabel,
} from "./GitPanelSyncPrompt";

const status: GitStatusResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "dev",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "src/app.ts", insertions: 2, deletions: 1 }],
    insertions: 2,
    deletions: 1,
  },
  hasUpstream: true,
  aheadCount: 3,
  behindCount: 2,
  pr: null,
};

describe("Git panel synchronization prompt", () => {
  it("formats directional status without contradictory up-to-date copy", () => {
    expect(formatGitSyncSummary({ ...status, aheadCount: 0, behindCount: 2 })).toBe("2 behind");
    expect(formatGitSyncSummary({ ...status, aheadCount: 3, behindCount: 0 })).toBe("3 ahead");
    expect(formatGitSyncSummary({ ...status, aheadCount: 0, behindCount: 0 })).toBe("Up to date");
    expect(formatGitSyncSummary(status)).toBe("3 ahead, 2 behind");
  });

  it("keeps investigation first and offers dirty-worktree choices", () => {
    const options = getGitSyncIssueOptions("dirty_pull");
    expect(options[0]?.value).toBe("investigate");
    expect(options[0]?.ctaLabel).toBe("Prepare investigation prompt");
    expect(options.map((option) => option.value)).toEqual([
      "investigate",
      "stash_pull_restore",
      "commit_before_pull",
    ]);
  });

  it("does not offer stash choices for clean divergence", () => {
    expect(getGitSyncIssueOptions("diverged").map((option) => option.value)).toEqual([
      "investigate",
      "rebase",
      "merge",
    ]);
  });

  it("builds a deterministic prompt with safety boundaries", () => {
    const prompt = buildGitSyncPrompt({
      cwd: "/repo/project",
      executionTargetId: "ssh:devbox",
      status,
      action: "pull",
      issue: "dirty_pull",
      preference: "stash_pull_restore",
      error: "working tree is dirty",
    });

    expect(prompt).toContain("Workspace: /repo/project");
    expect(prompt).toContain("Execution target: ssh:devbox");
    expect(prompt).toContain("3 ahead, 2 behind");
    expect(prompt).toContain("stash, use fast-forward-only Pull");
    expect(prompt).toContain("Never discard, reset, clean, overwrite, or force-push");
    expect(prompt).toContain("Do not commit or push without my explicit approval");
  });

  it("formats singular action labels", () => {
    expect(gitSyncActionLabel("pull", 1)).toBe("Pull 1 commit");
    expect(gitSyncActionLabel("push", 4)).toBe("Push 4 commits");
    expect(gitSyncActionLabel("fetch", 0)).toBe("Fetch");
  });
});
