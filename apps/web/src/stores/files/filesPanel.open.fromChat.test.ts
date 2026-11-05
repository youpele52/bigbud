import { describe, expect, it } from "vitest";

import { useBrowserPanelStore } from "../browser/browser.store";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useFilesPanelStore } from "./filesPanel.store";
import { openPathFromChat } from "./filesPanel.open";

function resetFilesPanelState() {
  useBrowserPanelStore.setState({
    open: false,
    tabsById: {},
  });
  useFilesPanelStore.setState({
    open: false,
    workspaceRootOverride: null,
    workspaceExecutionTargetIdOverride: null,
    previewPath: null,
    previewPosition: null,
    fileOpenRequest: null,
    directoryNavigationRequest: null,
  });
  useRightPanelTabsStore.setState({ activeKind: null, activeTabId: null, openTabs: [] });
}

describe("openPathFromChat", () => {
  const executionTargets = [
    "local",
    "ssh:host=devbox&transport=direct",
    "ssh:host=devbox&transport=agent",
  ] as const;

  it.each(executionTargets)(
    "preserves %s when opening worktree files and directories",
    async (executionTargetId) => {
      resetFilesPanelState();
      const workspaceRoot = "/srv/worktrees/feature";

      await openPathFromChat(
        `${workspaceRoot}/src/main.ts:8:3`,
        workspaceRoot,
        "file",
        executionTargetId,
      );

      expect(useFilesPanelStore.getState()).toMatchObject({
        workspaceRootOverride: null,
        workspaceExecutionTargetIdOverride: executionTargetId,
        fileOpenRequest: {
          path: "src/main.ts",
          position: { line: 8, column: 3 },
          workspaceRootOverride: null,
        },
      });

      await openPathFromChat(`${workspaceRoot}/src`, workspaceRoot, "directory", executionTargetId);

      expect(useFilesPanelStore.getState()).toMatchObject({
        workspaceRootOverride: null,
        workspaceExecutionTargetIdOverride: executionTargetId,
        directoryNavigationRequest: { path: "src", workspaceRootOverride: null },
      });
    },
  );

  it.each(executionTargets)("preserves %s in browser previews", async (executionTargetId) => {
    for (const relativePath of ["public/index.html", "images/photo.png", "docs/guide.pdf"]) {
      resetFilesPanelState();
      await openPathFromChat(
        `/srv/worktrees/feature/${relativePath}`,
        "/srv/worktrees/feature",
        "file",
        executionTargetId,
      );
      const tab = Object.values(useBrowserPanelStore.getState().tabsById)[0];
      const params = new URL(tab!.url, "http://localhost").searchParams;
      expect(params.get("cwd")).toBe("/srv/worktrees/feature");
      expect(params.get("relativePath")).toBe(relativePath);
      expect(params.get("executionTargetId")).toBe(
        executionTargetId === "local" ? null : executionTargetId,
      );
      expect(useFilesPanelStore.getState().fileOpenRequest).toBeNull();
    }
  });

  it.each(["file", "directory"] as const)(
    "pairs an external remote %s root override with its target in the open request",
    async (kind) => {
      resetFilesPanelState();
      await openPathFromChat("/srv/other/README.md", "/srv/project", kind, "ssh:vps");
      const state = useFilesPanelStore.getState();
      expect(state.workspaceExecutionTargetIdOverride).toBe("ssh:vps");
      if (kind === "file") {
        expect(state.workspaceRootOverride).toBe("/srv/other");
        expect(state.fileOpenRequest).toMatchObject({ path: "README.md" });
      } else {
        expect(state.workspaceRootOverride).toBe("/srv/other/README.md");
        expect(state.directoryNavigationRequest).toMatchObject({ path: "" });
      }
    },
  );

  it("replaces a stale remote override when opening a local workspace result", async () => {
    resetFilesPanelState();
    await openPathFromChat("/srv/project/remote.md", "/srv/project", "file", "ssh:vps");
    await openPathFromChat(
      "/Users/alice/project/local.md",
      "/Users/alice/project",
      "file",
      "local",
    );
    expect(useFilesPanelStore.getState()).toMatchObject({
      workspaceRootOverride: null,
      workspaceExecutionTargetIdOverride: "local",
      fileOpenRequest: { path: "local.md", requestId: 2 },
    });
  });

  it("opens workspace html files in the browser panel before the file viewer", async () => {
    resetFilesPanelState();

    await openPathFromChat("/Users/alice/project/public/index.html", "/Users/alice/project");

    const browserTabIds = Object.keys(useBrowserPanelStore.getState().tabsById);
    expect(useBrowserPanelStore.getState()).toMatchObject({
      open: true,
      tabsById: {
        [browserTabIds[0] ?? ""]: {
          url: expect.stringContaining("/api/workspace-file-preview?"),
        },
      },
    });
    expect(useFilesPanelStore.getState().fileOpenRequest).toBeNull();
  });

  it("opens markdown files in the files panel when browser preview is unavailable", async () => {
    resetFilesPanelState();

    await openPathFromChat("/Users/alice/project/README.md", "/Users/alice/project");

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: null,
      fileOpenRequest: {
        path: "README.md",
        position: null,
        workspaceRootOverride: null,
        requestId: 1,
      },
    });
    expect(Object.keys(useBrowserPanelStore.getState().tabsById)).toHaveLength(0);
  });

  it("opens supported files outside the current workspace inside the files panel", async () => {
    resetFilesPanelState();

    await openPathFromChat("/Users/alice/other-project/README.md", "/Users/alice/project");

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/other-project",
      fileOpenRequest: {
        path: "README.md",
        position: null,
        workspaceRootOverride: "/Users/alice/other-project",
        requestId: 1,
      },
    });
  });

  it("opens workspace directories in the files panel tree", async () => {
    resetFilesPanelState();

    await openPathFromChat(
      "/Users/alice/project/src/components",
      "/Users/alice/project",
      "directory",
    );

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: null,
      previewPath: null,
      directoryNavigationRequest: {
        path: "src/components",
        workspaceRootOverride: null,
        requestId: 1,
      },
    });
    expect(useFilesPanelStore.getState().fileOpenRequest).toBeNull();
  });

  it("opens external directories by rooting the files panel to the target folder", async () => {
    resetFilesPanelState();

    await openPathFromChat("/Users/alice/other-project/docs", "/Users/alice/project", "directory");

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/other-project/docs",
      previewPath: null,
      directoryNavigationRequest: {
        path: "",
        workspaceRootOverride: "/Users/alice/other-project/docs",
        requestId: 1,
      },
    });
    expect(useFilesPanelStore.getState().fileOpenRequest).toBeNull();
  });
});
