import { describe, expect, it } from "vitest";

import { createFilesPanelWorkspaceKey } from "./FilesPanel.workspace";

describe("createFilesPanelWorkspaceKey", () => {
  it("shares project history independently of thread directories", () => {
    expect(
      createFilesPanelWorkspaceKey({
        projectId: "project-1",
        workspaceRoot: "/worktrees/a",
        executionTargetId: "local:a",
      }),
    ).toBe("project:project-1::local:a");
  });

  it("shares recent-chat history by normalized directory and execution target", () => {
    expect(
      createFilesPanelWorkspaceKey({
        workspaceRoot: "/workspace/demo/",
        executionTargetId: "local:a",
      }),
    ).toBe("chat:/workspace/demo::local:a");
  });

  it("isolates chats without a directory", () => {
    expect(createFilesPanelWorkspaceKey({ workspaceRoot: null, isolatedId: "thread-1" })).toBe(
      "isolated:thread-1::local",
    );
  });
});
