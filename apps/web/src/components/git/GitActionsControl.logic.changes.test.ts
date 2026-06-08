import type { GitStatusResult } from "@bigbud/contracts";
import { assert, describe, it } from "vitest";
import { buildMenuItems, resolveQuickAction } from "./GitActionsControl.logic";

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

describe("when: working tree has local changes", () => {
  it("resolveQuickAction returns commit, push, and create PR", () => {
    const quick = resolveQuickAction(status({ hasWorkingTreeChanges: true }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push_pr",
      label: "Commit, Push & PR",
    });
  });

  it("resolveQuickAction falls back to commit when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({ hasWorkingTreeChanges: true, hasUpstream: false }),
      false,
      false,
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit",
      label: "Commit",
      disabled: false,
    });
  });

  it("resolveQuickAction returns commit and push when open PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasWorkingTreeChanges: true,
        pr: {
          number: 16,
          title: "Existing PR",
          url: "https://example.com/pr/16",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & Push",
    });
  });

  it("buildMenuItems enables commit and disables push and PR", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: on default branch without open PR", () => {
  it("resolveQuickAction returns commit and push when local changes exist", () => {
    const quick = resolveQuickAction(
      status({ branch: "main", hasWorkingTreeChanges: true }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & Push",
      disabled: false,
    });
  });

  it("resolveQuickAction returns push when branch is ahead", () => {
    const quick = resolveQuickAction(
      status({ branch: "main", aheadCount: 2, pr: null }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Push",
      disabled: false,
    });
  });
});

describe("when: working tree has local changes and branch is behind upstream", () => {
  it("resolveQuickAction still prefers commit, push, and create PR", () => {
    const quick = resolveQuickAction(
      status({ hasWorkingTreeChanges: true, behindCount: 1 }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push_pr",
      label: "Commit, Push & PR",
    });
  });

  it("buildMenuItems enables commit and keeps push and PR disabled", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true, behindCount: 2 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: HEAD is detached and there are no local changes", () => {
  it("resolveQuickAction shows detached head hint", () => {
    const quick = resolveQuickAction(
      status({ branch: null, hasWorkingTreeChanges: false, hasUpstream: false }),
      false,
    );
    assert.deepInclude(quick, { kind: "show_hint", label: "Commit", disabled: true });
  });

  it("buildMenuItems keeps commit, push, and PR disabled", () => {
    const items = buildMenuItems(status({ branch: null, hasWorkingTreeChanges: false }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});
