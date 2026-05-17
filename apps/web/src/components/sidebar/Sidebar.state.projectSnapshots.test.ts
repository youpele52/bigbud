import { describe, expect, it } from "vitest";

import { ProjectId } from "@bigbud/contracts";

import { buildSidebarProjectSnapshots } from "./Sidebar.state.projectSnapshots";

describe("buildSidebarProjectSnapshots", () => {
  it("forces disconnected remote projects closed until verified", () => {
    const remoteProjectId = ProjectId.makeUnsafe("project-remote");

    const snapshots = buildSidebarProjectSnapshots({
      orderedProjects: [
        {
          id: remoteProjectId,
          name: "Remote",
          cwd: "/srv/project",
          executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        } as never,
      ],
      projectExpandedById: {
        [remoteProjectId]: true,
      },
      verifiedExecutionTargetIds: {},
    });

    expect(snapshots[0]?.expanded).toBe(false);
  });

  it("preserves stored expansion for verified remote projects", () => {
    const remoteProjectId = ProjectId.makeUnsafe("project-remote");
    const executionTargetId = "ssh:host=devbox&user=root&port=22&auth=ssh-key";

    const snapshots = buildSidebarProjectSnapshots({
      orderedProjects: [
        {
          id: remoteProjectId,
          name: "Remote",
          cwd: "/srv/project",
          executionTargetId,
        } as never,
      ],
      projectExpandedById: {
        [remoteProjectId]: true,
      },
      verifiedExecutionTargetIds: {
        [executionTargetId]: true,
      },
    });

    expect(snapshots[0]?.expanded).toBe(true);
  });
});
