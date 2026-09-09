import { describe, expect, it } from "vitest";
import { ProjectId } from "@bigbud/contracts";
import { buildProjectContextMenuItems } from "./Sidebar.projectActions.menu";
import type { Project } from "../../models/types";

function project(target: string): Project {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Remote",
    cwd: "/workspace",
    workspaceExecutionTargetId: target as NonNullable<Project["workspaceExecutionTargetId"]>,
    defaultModelSelection: null,
    scripts: [],
  };
}

describe("project context menu", () => {
  it("puts reconnect first only for SSH projects and disables it while active", () => {
    const items = buildProjectContextMenuItems({
      project: project("ssh:host=devbox&user=root&port=22&auth=ssh-key"),
      reconnectDisabled: true,
    });

    expect(items[0]).toMatchObject({ id: "reconnect", label: "Reconnect", disabled: true });
    expect(items.map((item) => item.id)).toEqual([
      "reconnect",
      "rename",
      "edit-ssh",
      "copy-path",
      "delete",
    ]);
  });

  it("preserves the local project menu", () => {
    const items = buildProjectContextMenuItems({
      project: project("local"),
      reconnectDisabled: false,
    });
    expect(items.map((item) => item.id)).toEqual(["rename", "copy-path", "delete"]);
  });
});
