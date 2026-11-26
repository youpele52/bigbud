import { describe, expect, it } from "vitest";

import {
  createFilesPanelWorkspaceKey,
  resolveFilesPanelWorkspaceRootOverride,
} from "./FilesPanel.workspace";

describe("createFilesPanelWorkspaceKey", () => {
  it("keys project history by its absolute root, so worktrees never share or prune entries", () => {
    const key = (workspaceRoot: string) =>
      createFilesPanelWorkspaceKey({
        projectId: "project-1",
        workspaceRoot,
        executionTargetId: "local:a",
      });
    expect(key("/worktrees/a/")).toBe("project:project-1:/worktrees/a::local:a");
    expect(key("/worktrees/b")).not.toBe(key("/worktrees/a"));
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

describe("resolveFilesPanelWorkspaceRootOverride", () => {
  const base = {
    requestedExecutionTargetId: null,
    workspaceRoot: "/work/current",
    workspaceExecutionTargetId: "local",
  };

  it("treats a request for the panel's own root as the project workspace", () => {
    expect(
      resolveFilesPanelWorkspaceRootOverride({ ...base, requestedRoot: "/work/current/" }),
    ).toBe(null);
    expect(
      resolveFilesPanelWorkspaceRootOverride({
        ...base,
        requestedRoot: "/work/current",
        requestedExecutionTargetId: "local",
      }),
    ).toBe(null);
  });

  it("keeps another project's root, or the same folder on another target, as its own workspace", () => {
    expect(resolveFilesPanelWorkspaceRootOverride({ ...base, requestedRoot: "/work/other" })).toBe(
      "/work/other",
    );
    expect(
      resolveFilesPanelWorkspaceRootOverride({
        ...base,
        requestedRoot: "/work/current",
        requestedExecutionTargetId: "ssh:vps",
      }),
    ).toBe("/work/current");
    expect(resolveFilesPanelWorkspaceRootOverride({ ...base, requestedRoot: null })).toBe(null);
  });
});
