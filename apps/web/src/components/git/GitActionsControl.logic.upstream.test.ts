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

describe("when: branch has no upstream configured", () => {
  it("resolveQuickAction is disabled when clean, no upstream, and no local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({ hasUpstream: false, pr: null, aheadCount: 0 }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Push",
      hint: "No local commits to push.",
      disabled: true,
    });
  });

  it("resolveQuickAction opens PR when clean, no upstream, no local commits are ahead, and PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 0,
        pr: {
          number: 14,
          title: "Existing PR",
          url: "https://example.com/pr/14",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "open_pr",
      label: "View PR",
      disabled: false,
    });
  });

  it("resolveQuickAction runs push when clean, no upstream, and local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 1,
        pr: {
          number: 15,
          title: "Existing PR",
          url: "https://example.com/pr/15",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "push",
      label: "Push",
      disabled: false,
    });
  });

  it("buildMenuItems disables push and create PR when no commits are ahead", () => {
    const items = buildMenuItems(status({ hasUpstream: false, pr: null, aheadCount: 0 }), false);
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

  it("resolveQuickAction runs push and create PR when no upstream and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & Create PR",
      disabled: false,
    });
  });

  it("resolveQuickAction disables push-and-pr flows when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
      false,
      false,
    );
    assert.deepEqual(quick, {
      kind: "show_hint",
      label: "Push",
      hint: 'Add an "origin" remote before pushing or creating a PR.',
      disabled: true,
    });
  });

  it("buildMenuItems enables create PR when no upstream and commits are ahead", () => {
    const items = buildMenuItems(status({ hasUpstream: false, pr: null, aheadCount: 2 }), false);
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
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("buildMenuItems disables push and create PR when no origin remote exists", () => {
    const items = buildMenuItems(
      status({ hasUpstream: false, pr: null, aheadCount: 2 }),
      false,
      false,
    );
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

  it("resolveQuickAction is disabled on default branch when no upstream exists and no commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        branch: "main",
        hasUpstream: false,
        aheadCount: 0,
        pr: null,
      }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Push",
      hint: "No local commits to push.",
      disabled: true,
    });
  });

  it("resolveQuickAction uses push-only on default branch when no upstream exists and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        branch: "main",
        hasUpstream: false,
        aheadCount: 1,
        pr: null,
      }),
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

  it("buildMenuItems still disables push and create PR when branch is behind", () => {
    const items = buildMenuItems(
      status({
        hasUpstream: false,
        behindCount: 1,
        aheadCount: 0,
        pr: null,
      }),
      false,
    );
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
