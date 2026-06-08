import type { GitStatusResult } from "@bigbud/contracts";
import { assert, describe, it } from "vitest";
import {
  resolveAutoFeatureBranchName,
  resolveLiveThreadBranchUpdate,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    isRepo: true,
    hasOriginRemote: true,
    isDefaultBranch: false,
    branch: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("resolveThreadBranchUpdate", () => {
  it("returns a branch update when the action created a new branch", () => {
    const update = resolveThreadBranchUpdate({
      action: "commit_push_pr",
      branch: {
        status: "created",
        name: "feature/fix-toast-copy",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: add branch sync",
      },
      push: { status: "pushed", branch: "feature/fix-toast-copy" },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed 89abcde to origin/feature/fix-toast-copy",
        cta: { kind: "none" },
      },
    });

    assert.deepEqual(update, {
      branch: "feature/fix-toast-copy",
    });
  });

  it("returns null when the action stayed on the existing branch", () => {
    const update = resolveThreadBranchUpdate({
      action: "commit_push",
      branch: {
        status: "skipped_not_requested",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: add branch sync",
      },
      push: { status: "pushed", branch: "feature/fix-toast-copy" },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed 89abcde to origin/feature/fix-toast-copy",
        cta: { kind: "none" },
      },
    });

    assert.equal(update, null);
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("returns a branch update when live git status differs from stored thread metadata", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-branch",
      gitStatus: status({ branch: "effect-atom" }),
    });

    assert.deepEqual(update, {
      branch: "effect-atom",
    });
  });

  it("returns null when live git status is unavailable", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-branch",
      gitStatus: null,
    });

    assert.equal(update, null);
  });

  it("returns null when the stored thread branch already matches git status", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ branch: "effect-atom" }),
    });

    assert.equal(update, null);
  });

  it("returns null when git status is detached HEAD but the thread already has a branch", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ branch: null }),
    });

    assert.equal(update, null);
  });

  it("does not regress a semantic thread branch back to a temporary worktree branch", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "bigbud/github-query-rate-limit",
      gitStatus: status({ branch: "bigbud/bda76797" }),
    });

    assert.equal(update, null);
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("uses semantic preferred branch names when available", () => {
    const branch = resolveAutoFeatureBranchName(["main", "feature/other"], "fix toast copy");
    assert.equal(branch, "feature/fix-toast-copy");
  });

  it("normalizes preferred names that already include a branch namespace", () => {
    const branch = resolveAutoFeatureBranchName(["main"], "feature/refine-toolbar-actions");
    assert.equal(branch, "feature/refine-toolbar-actions");
  });

  it("increments suffix when the preferred branch name already exists", () => {
    const branch = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(branch, "feature/fix-toast-copy-3");
  });

  it("treats existing branch names as case-insensitive for collision checks", () => {
    const branch = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(branch, "feature/ticket-1-2");
  });

  it("falls back to feature/update when no preferred name is provided", () => {
    const branch = resolveAutoFeatureBranchName(["main"]);
    assert.equal(branch, "feature/update");
  });
});
