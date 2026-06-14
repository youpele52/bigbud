import type { GitStatusResult } from "@bigbud/contracts";
import { assert, describe, it } from "vitest";
import { buildMenuItems, getMenuActionDisabledReason } from "./GitActionsControl.logic";

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

describe("buildMenuItems", () => {
  it("returns only Initialize Git when not a repo", () => {
    const items = buildMenuItems(status({ isRepo: false }), false);

    assert.deepEqual(
      items.map((item) => item.id),
      ["initialize_git"],
    );
    assert.isFalse(items[0]?.disabled);
  });

  it("enables Commit and disables Push/Pull when there are working tree changes", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true }), false);
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));

    assert.isFalse(byId.commit?.disabled);
    assert.isTrue(byId.push?.disabled);
    assert.isTrue(byId.pull?.disabled);
    assert.isFalse(byId.fetch?.disabled);
    assert.isFalse(byId.discard_changes?.disabled);
    assert.isFalse(byId.view_git_panel?.disabled);
    assert.isFalse(byId.view_history?.disabled);
  });

  it("enables Push when clean and ahead of upstream", () => {
    const items = buildMenuItems(status({ aheadCount: 2 }), false);
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));

    assert.isTrue(byId.commit?.disabled);
    assert.isFalse(byId.push?.disabled);
    assert.isTrue(byId.pull?.disabled);
    assert.isFalse(byId.view_git_panel?.disabled);
  });

  it("enables Pull when clean and behind upstream", () => {
    const items = buildMenuItems(status({ behindCount: 3 }), false);
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));

    assert.isTrue(byId.commit?.disabled);
    assert.isTrue(byId.push?.disabled);
    assert.isFalse(byId.pull?.disabled);
  });

  it("disables Push and Pull when HEAD is detached", () => {
    const items = buildMenuItems(status({ branch: null, aheadCount: 2, behindCount: 1 }), false);
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));

    assert.isTrue(byId.push?.disabled);
    assert.isTrue(byId.pull?.disabled);
  });

  it("disables all git actions while busy", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true, aheadCount: 2 }), true);

    for (const item of items) {
      if (item.id === "view_git_panel" || item.id === "view_history") continue;
      assert.isTrue(item.disabled, `${item.id} should be disabled while busy`);
    }
  });

  it("returns no items when git status is unavailable", () => {
    const items = buildMenuItems(null, false);

    assert.deepEqual(items, []);
  });
});

describe("getMenuActionDisabledReason", () => {
  it("explains why push is disabled when there are local changes", () => {
    const reason = getMenuActionDisabledReason({
      item: { id: "push", disabled: true } as ReturnType<typeof buildMenuItems>[number],
      gitStatus: status({ hasWorkingTreeChanges: true }),
      isBusy: false,
      hasOriginRemote: true,
    });

    assert.equal(reason, "Commit or stash local changes before pushing.");
  });

  it("explains why pull is disabled when the branch is up to date", () => {
    const reason = getMenuActionDisabledReason({
      item: { id: "pull", disabled: true } as ReturnType<typeof buildMenuItems>[number],
      gitStatus: status(),
      isBusy: false,
      hasOriginRemote: true,
    });

    assert.equal(reason, "Branch is up to date. Nothing to pull.");
  });

  it("explains why fetch is disabled when no origin remote exists", () => {
    const reason = getMenuActionDisabledReason({
      item: { id: "fetch", disabled: true } as ReturnType<typeof buildMenuItems>[number],
      gitStatus: status(),
      isBusy: false,
      hasOriginRemote: false,
    });

    assert.equal(reason, 'Add an "origin" remote before fetching.');
  });

  it("explains why discard changes is disabled when worktree is clean", () => {
    const reason = getMenuActionDisabledReason({
      item: { id: "discard_changes", disabled: true } as ReturnType<typeof buildMenuItems>[number],
      gitStatus: status({ hasWorkingTreeChanges: false }),
      isBusy: false,
      hasOriginRemote: true,
    });

    assert.equal(reason, "Worktree is clean. Nothing to discard.");
  });
});
