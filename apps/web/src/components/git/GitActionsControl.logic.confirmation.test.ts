import { assert, describe, it } from "vitest";
import {
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
} from "./GitActionsControl.logic";

describe("requiresDefaultBranchConfirmation", () => {
  it("requires confirmation for push actions on default branch", () => {
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isTrue(requiresDefaultBranchConfirmation("push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("create_pr", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push_pr", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit_push", false));
    assert.isFalse(requiresDefaultBranchConfirmation("push", false));
  });
});

describe("resolveDefaultBranchActionDialogCopy", () => {
  it("uses push-only copy when pushing without a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push",
      branchName: "main",
      includesCommit: false,
    });

    assert.deepEqual(copy, {
      title: "Push to default branch?",
      description:
        'This action will push local commits on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Push to main",
    });
  });

  it("uses push-and-pr copy when creating a PR without a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push_pr",
      branchName: "main",
      includesCommit: false,
    });

    assert.deepEqual(copy, {
      title: "Push & create PR from default branch?",
      description:
        'This action will push local commits and create a PR on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Push & create PR",
    });
  });

  it("keeps commit copy when the action includes a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push_pr",
      branchName: "main",
      includesCommit: true,
    });

    assert.deepEqual(copy, {
      title: "Commit, push & create PR from default branch?",
      description:
        'This action will commit, push, and create a PR on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Commit, push & create PR",
    });
  });
});
