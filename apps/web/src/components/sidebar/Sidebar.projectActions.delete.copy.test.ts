import { describe, expect, it } from "vitest";
import { projectDeleteConfirmationCopy } from "./Sidebar.projectActions.delete.copy";

describe("project removal confirmation wording", () => {
  it("preserves local project copy", () => {
    expect(
      projectDeleteConfirmationCopy({
        projectName: "app",
        threadCount: 1,
        isRemoteWorkspace: false,
      }),
    ).toEqual({
      title: 'Delete project "app"?',
      description:
        "This project has 1 thread that will also be deleted. This only removes the project from bigbud, not from your system.",
    });
  });

  it("names remote workspaces and clarifies that removing them does not delete remote files", () => {
    expect(
      projectDeleteConfirmationCopy({
        projectName: "dev-vps",
        threadCount: 2,
        isRemoteWorkspace: true,
      }),
    ).toEqual({
      title: 'Delete remote workspace "dev-vps"?',
      description:
        "This remote workspace has 2 threads that will also be deleted. This only removes the workspace from bigbud, not from your system.",
    });
    expect(
      projectDeleteConfirmationCopy({
        projectName: "dev-vps",
        threadCount: 0,
        isRemoteWorkspace: true,
      }).description,
    ).toBe("This only removes the workspace from bigbud, not from your system.");
  });
});
