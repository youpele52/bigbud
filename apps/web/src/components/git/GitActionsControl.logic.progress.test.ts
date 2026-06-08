import { assert, describe, it } from "vitest";
import { buildGitActionProgressStages } from "./GitActionsControl.logic";

describe("buildGitActionProgressStages", () => {
  it("shows only push progress for explicit push actions", () => {
    const stages = buildGitActionProgressStages({
      action: "push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: false,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, ["Pushing to origin/feature/test..."]);
  });

  it("shows push and PR progress for create-pr actions that still need a push", () => {
    const stages = buildGitActionProgressStages({
      action: "create_pr",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: false,
      pushTarget: "origin/feature/test",
      shouldPushBeforePr: true,
    });
    assert.deepEqual(stages, [
      "Pushing to origin/feature/test...",
      "Preparing PR...",
      "Generating PR content...",
      "Creating GitHub pull request...",
    ]);
  });

  it("shows only PR progress when create-pr can skip the push", () => {
    const stages = buildGitActionProgressStages({
      action: "create_pr",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: false,
      shouldPushBeforePr: false,
    });
    assert.deepEqual(stages, [
      "Preparing PR...",
      "Generating PR content...",
      "Creating GitHub pull request...",
    ]);
  });

  it("includes commit stages for commit+push when working tree is dirty", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, [
      "Generating commit message...",
      "Committing...",
      "Pushing to origin/feature/test...",
    ]);
  });

  it("includes granular PR stages for commit+push+PR actions", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push_pr",
      hasCustomCommitMessage: true,
      hasWorkingTreeChanges: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, [
      "Committing...",
      "Pushing to origin/feature/test...",
      "Preparing PR...",
      "Generating PR content...",
      "Creating GitHub pull request...",
    ]);
  });
});
