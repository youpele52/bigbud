import type { NativeApi } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useBrowserPanelStore } from "../../stores/browser/browser.store";
import { useRightPanelTabsStore } from "../../stores/rightPanel/rightPanelTabs.store";
import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
import { openTerminalPath } from "./TerminalViewport.links.open";

function resetPanelState() {
  useBrowserPanelStore.setState({ open: false, tabsById: {} });
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

function makeApi() {
  const listDirectory = vi.fn();
  const openInEditor = vi.fn();
  const api = {
    projects: { listDirectory },
    shell: { openInEditor },
  } as unknown as NativeApi;
  return { api, listDirectory, openInEditor };
}

function fileEntry(path: string) {
  return { path, kind: "file" as const };
}

function directoryEntry(path: string) {
  return { path, kind: "directory" as const };
}

beforeEach(() => {
  resetPanelState();
});

describe("openTerminalPath", () => {
  it("normalizes dot segments and opens an in-workspace file with its position", async () => {
    const { api, listDirectory } = makeApi();
    listDirectory.mockResolvedValue({ entries: [fileEntry("src/index.ts")] });

    await openTerminalPath({
      api,
      rawPath: "./src/../src/index.ts:12:4",
      cwd: "/Users/alice/project",
      workspaceRoot: "/Users/alice/project",
    });

    expect(listDirectory).toHaveBeenCalledWith({
      cwd: "/Users/alice/project",
      relativePath: "src",
    });
    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: null,
      workspaceExecutionTargetIdOverride: null,
      fileOpenRequest: {
        path: "src/index.ts",
        position: { line: 12, column: 4 },
        workspaceRootOverride: null,
      },
    });
  });

  it("normalizes Windows paths case-insensitively before classifying a local file", async () => {
    const { api, listDirectory } = makeApi();
    listDirectory.mockResolvedValue({ entries: [fileEntry("src/index.ts")] });

    await openTerminalPath({
      api,
      rawPath: ".\\src\\..\\src\\index.ts:6",
      cwd: "C:\\Users\\Alice\\Project",
      workspaceRoot: "C:\\Users\\alice\\project",
    });

    expect(listDirectory).toHaveBeenCalledWith({
      cwd: "C:/Users/alice/project",
      relativePath: "src",
    });
    expect(useFilesPanelStore.getState().fileOpenRequest).toMatchObject({
      path: "src/index.ts",
      position: { line: 6, column: null },
    });
  });

  it("normalizes UNC paths before classifying a remote file", async () => {
    const { api, listDirectory } = makeApi();
    listDirectory.mockResolvedValue({ entries: [fileEntry("src/index.ts")] });

    await openTerminalPath({
      api,
      rawPath: ".\\src\\..\\src\\index.ts",
      cwd: "\\\\server\\share\\workspace",
      workspaceRoot: "\\\\server\\share\\workspace",
      executionTargetId: "ssh:dev",
    });

    expect(listDirectory).toHaveBeenCalledWith({
      cwd: "//server/share/workspace",
      executionTargetId: "ssh:dev",
      relativePath: "src",
    });
    expect(useFilesPanelStore.getState()).toMatchObject({
      workspaceRootOverride: null,
      workspaceExecutionTargetIdOverride: "ssh:dev",
      fileOpenRequest: { path: "src/index.ts" },
    });
  });

  it("uses the authoritative directory kind for an in-workspace directory", async () => {
    const { api, listDirectory } = makeApi();
    listDirectory.mockResolvedValue({ entries: [directoryEntry("src/components.txt")] });

    await openTerminalPath({
      api,
      rawPath: "src/../src/components.txt",
      cwd: "/Users/alice/project",
      workspaceRoot: "/Users/alice/project",
    });

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      directoryNavigationRequest: {
        path: "src/components.txt",
        workspaceRootOverride: null,
      },
    });
    expect(useFilesPanelStore.getState().fileOpenRequest).toBeNull();
  });

  it("preserves the local external-file Files-panel policy without opening an editor", async () => {
    const { api, listDirectory, openInEditor } = makeApi();
    listDirectory.mockResolvedValue({ entries: [fileEntry("README.md")] });

    await openTerminalPath({
      api,
      rawPath: "../outside/README.md:7",
      cwd: "/Users/alice/project",
      workspaceRoot: "/Users/alice/project",
    });

    expect(listDirectory).toHaveBeenCalledWith({ cwd: "/Users/alice/outside" });
    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/outside",
      fileOpenRequest: {
        path: "README.md",
        position: { line: 7, column: null },
        workspaceRootOverride: "/Users/alice/outside",
      },
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("preserves the local external-directory Files-panel policy", async () => {
    const { api, listDirectory } = makeApi();
    listDirectory.mockResolvedValue({ entries: [directoryEntry("outside")] });

    await openTerminalPath({
      api,
      rawPath: "../outside",
      cwd: "/Users/alice/project",
      workspaceRoot: "/Users/alice/project",
    });

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/outside",
      directoryNavigationRequest: {
        path: "",
        workspaceRootOverride: "/Users/alice/outside",
      },
    });
  });

  it("passes the exact execution target while opening a remote file", async () => {
    const { api, listDirectory } = makeApi();
    listDirectory.mockResolvedValue({ entries: [fileEntry("src/index.ts")] });

    await openTerminalPath({
      api,
      rawPath: "src/index.ts:8:2",
      cwd: "/srv/project",
      workspaceRoot: "/srv/project",
      executionTargetId: "ssh:dev",
    });

    expect(listDirectory).toHaveBeenCalledWith({
      cwd: "/srv/project",
      relativePath: "src",
      executionTargetId: "ssh:dev",
    });
    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: null,
      workspaceExecutionTargetIdOverride: "ssh:dev",
      fileOpenRequest: {
        path: "src/index.ts",
        position: { line: 8, column: 2 },
      },
    });
  });

  it("passes the exact execution target while opening a remote directory", async () => {
    const { api, listDirectory } = makeApi();
    listDirectory.mockResolvedValue({ entries: [directoryEntry("src")] });

    await openTerminalPath({
      api,
      rawPath: "src",
      cwd: "/srv/project",
      workspaceRoot: "/srv/project",
      executionTargetId: "ssh:dev",
    });

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: null,
      workspaceExecutionTargetIdOverride: "ssh:dev",
      directoryNavigationRequest: {
        path: "src",
      },
    });
  });

  it("opens supported remote files in the browser with the execution target", async () => {
    const { api, listDirectory } = makeApi();
    listDirectory.mockResolvedValue({ entries: [fileEntry("public/index.html")] });

    await openTerminalPath({
      api,
      rawPath: "public/index.html",
      cwd: "/srv/project",
      workspaceRoot: "/srv/project",
      executionTargetId: "ssh:dev",
    });

    const browserTabId = Object.keys(useBrowserPanelStore.getState().tabsById)[0];
    expect(useBrowserPanelStore.getState().tabsById[browserTabId ?? ""]?.url).toContain(
      "executionTargetId=ssh%3Adev",
    );
    expect(useFilesPanelStore.getState().fileOpenRequest).toBeNull();
  });

  it("fails closed for remote paths outside the active workspace before any RPC", async () => {
    const { api, listDirectory } = makeApi();

    await expect(
      openTerminalPath({
        api,
        rawPath: "../other/index.ts",
        cwd: "/srv/project",
        workspaceRoot: "/srv/project",
        executionTargetId: "ssh:dev",
      }),
    ).rejects.toThrow("outside the active remote workspace");

    expect(listDirectory).not.toHaveBeenCalled();
    expect(useFilesPanelStore.getState()).toMatchObject({
      open: false,
      workspaceRootOverride: null,
      workspaceExecutionTargetIdOverride: null,
      fileOpenRequest: null,
      directoryNavigationRequest: null,
    });
    expect(useBrowserPanelStore.getState().tabsById).toEqual({});
  });

  it("does not mutate panels when the classified entry is missing or inaccessible", async () => {
    const { api, listDirectory } = makeApi();
    listDirectory.mockResolvedValueOnce({ entries: [] });

    await expect(
      openTerminalPath({
        api,
        rawPath: "src/missing.ts",
        cwd: "/Users/alice/project",
        workspaceRoot: "/Users/alice/project",
      }),
    ).rejects.toThrow("missing or inaccessible");
    expect(useFilesPanelStore.getState().open).toBe(false);

    resetPanelState();
    listDirectory.mockRejectedValueOnce(new Error("permission denied"));
    await expect(
      openTerminalPath({
        api,
        rawPath: "src/blocked.ts",
        cwd: "/Users/alice/project",
        workspaceRoot: "/Users/alice/project",
      }),
    ).rejects.toThrow("permission denied");
    expect(useFilesPanelStore.getState().open).toBe(false);
  });

  it("uses the returned file kind instead of guessing from the extension", async () => {
    const { api, listDirectory } = makeApi();
    listDirectory.mockResolvedValue({ entries: [fileEntry("docs")] });

    await openTerminalPath({
      api,
      rawPath: "docs",
      cwd: "/Users/alice/project",
      workspaceRoot: "/Users/alice/project",
    });

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      fileOpenRequest: { path: "docs", position: null },
    });
    expect(useFilesPanelStore.getState().directoryNavigationRequest).toBeNull();
  });
});
