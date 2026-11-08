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
  it("puts Reconnect and Disconnect directly above Remove for SSH projects", () => {
    const items = buildProjectContextMenuItems({
      project: project("ssh:host=devbox&user=root&port=22&auth=ssh-key"),
      reconnectDisabled: true,
      disconnected: false,
    });

    expect(items[3]).toMatchObject({ id: "reconnect", label: "Reconnect", disabled: true });
    expect(items.map((item) => item.label)).toEqual([
      "Rename remote workspace",
      "Edit remote workspace",
      "Copy Workspace Path",
      "Reconnect",
      "Disconnect",
      "Remove remote workspace",
    ]);
    expect(items.map((item) => item.id)).toEqual([
      "rename",
      "edit-ssh",
      "copy-path",
      "reconnect",
      "disconnect",
      "delete",
    ]);
  });

  it("allows reconnect for an SSH project without requiring a disconnected state", () => {
    const items = buildProjectContextMenuItems({
      project: project("ssh:host=devbox&user=root&port=22&auth=ssh-key"),
      reconnectDisabled: false,
      disconnected: false,
    });
    expect(items.find((item) => item.id === "reconnect")).toEqual({
      id: "reconnect",
      label: "Reconnect",
      disabled: false,
    });
  });

  it("offers Connect above Remove and hides Reconnect while disconnected", () => {
    const items = buildProjectContextMenuItems({
      project: project("ssh:host=devbox&user=root&port=22&auth=password&transport=direct-ssh"),
      reconnectDisabled: false,
      disconnected: true,
    });
    const ids = items.map((item) => item.id);

    expect(ids).toEqual(["rename", "edit-ssh", "copy-path", "connect", "delete"]);
    expect(ids).not.toContain("reconnect");
    expect(ids).not.toContain("disconnect");
    expect(items[ids.indexOf("connect")]).toEqual({ id: "connect", label: "Connect" });
  });

  it("places Disconnect immediately after Reconnect for agent workspaces", () => {
    const items = buildProjectContextMenuItems({
      project: project("ssh:host=devbox&user=root&port=22&auth=ssh-key&transport=agent"),
      reconnectDisabled: false,
      disconnected: false,
    });
    const ids = items.map((item) => item.id);

    expect(ids.indexOf("disconnect")).toBe(ids.indexOf("reconnect") + 1);
    expect(ids.indexOf("delete")).toBe(ids.indexOf("disconnect") + 1);
    expect(items[ids.indexOf("disconnect")]).toEqual({ id: "disconnect", label: "Disconnect" });
  });

  it("preserves the local project menu", () => {
    const items = buildProjectContextMenuItems({
      project: project("local"),
      reconnectDisabled: false,
      disconnected: false,
    });
    expect(items.map((item) => item.id)).toEqual(["rename", "edit-local", "copy-path", "delete"]);
    expect(
      buildProjectContextMenuItems({
        project: project("local"),
        reconnectDisabled: false,
        disconnected: true,
      }).map((item) => item.id),
    ).toEqual(["rename", "edit-local", "copy-path", "delete"]);
    expect(items.map((item) => item.label)).toEqual([
      "Rename project",
      "Edit project",
      "Copy Project Path",
      "Remove project",
    ]);
  });
});
