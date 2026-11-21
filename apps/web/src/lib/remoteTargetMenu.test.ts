import { ProjectId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { buildProjectContextMenuItems } from "../components/sidebar/Sidebar.projectActions.menu";
import { buildThreadContextMenuItems } from "../components/sidebar/Sidebar.threadActions.menu";
import type { Project } from "../models/types";
import { buildRemoteTargetMenuItems, isRemoteTargetMenuActionId } from "./remoteTargetMenu";

const SSH = "ssh:host=ice-2-kg&user=root&port=22&auth=password";
const REMOTE_IDS = new Set(["reconnect", "disconnect", "connect"]);

describe("buildRemoteTargetMenuItems", () => {
  it("is empty for local and non-SSH targets", () => {
    for (const executionTargetId of ["local", null, undefined, "remote:agent-1"]) {
      expect(
        buildRemoteTargetMenuItems({
          executionTargetId,
          disconnected: false,
          reconnectPending: false,
        }),
      ).toEqual([]);
    }
  });

  it("offers Reconnect then Disconnect for a connected SSH target, Reconnect disabled while pending", () => {
    expect(
      buildRemoteTargetMenuItems({
        executionTargetId: SSH,
        disconnected: false,
        reconnectPending: true,
      }),
    ).toEqual([
      { id: "reconnect", label: "Reconnect", disabled: true },
      { id: "disconnect", label: "Disconnect" },
    ]);
  });

  it("offers only Connect once the user disconnected", () => {
    expect(
      buildRemoteTargetMenuItems({
        executionTargetId: SSH,
        disconnected: true,
        reconnectPending: false,
      }),
    ).toEqual([{ id: "connect", label: "Connect" }]);
  });

  it("recognises only remote item ids", () => {
    expect(isRemoteTargetMenuActionId("reconnect")).toBe(true);
    expect(isRemoteTargetMenuActionId("delete")).toBe(false);
    expect(isRemoteTargetMenuActionId(null)).toBe(false);
  });

  it("the workspace menu and the thread menu show identical remote items (parity)", () => {
    const project = {
      id: ProjectId.makeUnsafe("project-1"),
      name: "Remote",
      cwd: "/srv",
      workspaceExecutionTargetId: SSH,
      defaultModelSelection: null,
      scripts: [],
    } as unknown as Project;
    for (const disconnected of [false, true]) {
      const remoteItems = buildRemoteTargetMenuItems({
        executionTargetId: SSH,
        disconnected,
        reconnectPending: false,
      });
      const fromProject = buildProjectContextMenuItems({
        project,
        reconnectDisabled: false,
        disconnected,
      }).filter((item) => REMOTE_IDS.has(item.id));
      const fromThread = buildThreadContextMenuItems({
        thread: { title: "t", elevatorSummary: null, pinnedAt: null, organization: undefined },
        remoteItems,
      }).filter((item) => REMOTE_IDS.has(item.id));
      expect(fromThread).toEqual(fromProject);
    }
  });
});
