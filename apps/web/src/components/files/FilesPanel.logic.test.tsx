import type { ProjectEntry } from "@bigbud/contracts";
import type { Dispatch, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  applyFileOpenRequest,
  applyPreviewDirectoryNavigation,
  getRemovedEntryPaths,
  getParentDirectoryPath,
  reconcilePreviewPathAfterDirectoryRefresh,
} from "./FilesPanel.logic";
import { renderFilesPanelTree } from "./FilesPanel.tree";
import type { DirectoryState } from "./FilesPanel.shared";

function renderRootTree(rootState: DirectoryState): string {
  const sortedRootEntries = rootState.entries;
  const showRootLoading = rootState.loading && sortedRootEntries.length === 0;

  if (showRootLoading) {
    return renderToStaticMarkup(<div>Loading files...</div>);
  }

  if (rootState.error) {
    return renderToStaticMarkup(<div>{rootState.error}</div>);
  }

  return renderToStaticMarkup(
    <div>
      {renderFilesPanelTree({
        entries: sortedRootEntries,
        depth: 0,
        workspaceRoot: "/tmp/workspace",
        previewPath: null,
        resolvedTheme: "dark",
        expandedDirectories: {},
        directoryStateByPath: {},
        onToggleDirectory: () => undefined,
        onOpenFile: () => undefined,
        onOpenContextMenu: () => undefined,
      })}
    </div>,
  );
}

describe("FilesPanel root loading behavior", () => {
  it("keeps cached root entries visible during background refresh", () => {
    const markup = renderRootTree({
      entries: [{ path: "README.md", kind: "file" } satisfies ProjectEntry],
      loading: true,
      error: null,
    });

    expect(markup).toContain("README.md");
    expect(markup).not.toContain("Loading files...");
  });

  it("shows root loading placeholder on first load without cached entries", () => {
    const markup = renderRootTree({
      entries: [],
      loading: true,
      error: null,
    });

    expect(markup).toContain("Loading files...");
  });
});

describe("reconcilePreviewPathAfterDirectoryRefresh", () => {
  it("closes the old preview path when a file is renamed", () => {
    expect(
      reconcilePreviewPathAfterDirectoryRefresh({
        previewPath: "docs/CHANGELOG.md",
        refreshedRelativePath: "docs",
        previousEntries: [
          { path: "docs/CHANGELOG.md", kind: "file", parentPath: "docs" } satisfies ProjectEntry,
        ],
        nextEntries: [
          { path: "docs/changelog.md", kind: "file", parentPath: "docs" } satisfies ProjectEntry,
        ],
      }),
    ).toBeNull();
  });

  it("keeps the preview path when the current file still exists", () => {
    expect(
      reconcilePreviewPathAfterDirectoryRefresh({
        previewPath: "docs/CHANGELOG.md",
        refreshedRelativePath: "docs",
        previousEntries: [
          { path: "docs/CHANGELOG.md", kind: "file", parentPath: "docs" } satisfies ProjectEntry,
        ],
        nextEntries: [
          { path: "docs/CHANGELOG.md", kind: "file", parentPath: "docs" } satisfies ProjectEntry,
          { path: "docs/changelog.md", kind: "file", parentPath: "docs" } satisfies ProjectEntry,
        ],
      }),
    ).toBe("docs/CHANGELOG.md");
  });

  it("closes the preview when the file disappears after an ambiguous refresh", () => {
    expect(
      reconcilePreviewPathAfterDirectoryRefresh({
        previewPath: "docs/CHANGELOG.md",
        refreshedRelativePath: "docs",
        previousEntries: [
          { path: "docs/CHANGELOG.md", kind: "file", parentPath: "docs" } satisfies ProjectEntry,
          { path: "docs/release.md", kind: "file", parentPath: "docs" } satisfies ProjectEntry,
        ],
        nextEntries: [
          { path: "docs/changelog.md", kind: "file", parentPath: "docs" } satisfies ProjectEntry,
          {
            path: "docs/release-notes.md",
            kind: "file",
            parentPath: "docs",
          } satisfies ProjectEntry,
        ],
      }),
    ).toBeNull();
  });

  it("closes the preview when the file is deleted", () => {
    expect(
      reconcilePreviewPathAfterDirectoryRefresh({
        previewPath: "docs/CHANGELOG.md",
        refreshedRelativePath: "docs",
        previousEntries: [
          { path: "docs/CHANGELOG.md", kind: "file", parentPath: "docs" } satisfies ProjectEntry,
        ],
        nextEntries: [],
      }),
    ).toBeNull();
  });
});

describe("getRemovedEntryPaths", () => {
  it("reports deleted and renamed old paths for history cleanup", () => {
    expect(
      getRemovedEntryPaths(
        [
          { path: "docs/old.md", kind: "file" },
          { path: "docs/keep.md", kind: "file" },
        ],
        [
          { path: "docs/new.md", kind: "file" },
          { path: "docs/keep.md", kind: "file" },
        ],
      ),
    ).toEqual(["docs/old.md"]);
  });
});

describe("preview directory navigation", () => {
  it("returns the immediate parent directory", () => {
    expect(getParentDirectoryPath("src/components/FilesPanel.tsx")).toBe("src/components");
    expect(getParentDirectoryPath("README.md")).toBe("");
  });

  it("expands the parent chain and loads only missing directories", () => {
    const loadedDirectories: string[] = [];
    let expandedDirectories: Record<string, boolean> = { src: false, test: true };

    applyPreviewDirectoryNavigation(
      "src/components/FilesPanel.tsx",
      { src: {} },
      (path) => {
        loadedDirectories.push(path);
      },
      (update) => {
        expandedDirectories = typeof update === "function" ? update(expandedDirectories) : update;
      },
    );

    expect(expandedDirectories).toEqual({ src: true, "src/components": true, test: true });
    expect(loadedDirectories).toEqual(["src/components"]);
  });

  it("does nothing for a root-level preview", () => {
    let expansionUpdates = 0;
    const loadedDirectories: string[] = [];

    applyPreviewDirectoryNavigation(
      "README.md",
      {},
      (path) => {
        loadedDirectories.push(path);
      },
      () => {
        expansionUpdates += 1;
      },
    );

    expect(expansionUpdates).toBe(0);
    expect(loadedDirectories).toEqual([]);
  });

  it("preserves the expansion state reference when the parent chain is already open", () => {
    const expandedDirectories = { src: true, "src/components": true };
    let nextExpandedDirectories: Record<string, boolean> | undefined;

    applyPreviewDirectoryNavigation(
      "src/components/FilesPanel.tsx",
      { src: {}, "src/components": {} },
      () => undefined,
      (update) => {
        nextExpandedDirectories =
          typeof update === "function" ? update(expandedDirectories) : update;
      },
    );

    expect(nextExpandedDirectories).toBe(expandedDirectories);
  });
});

describe("file open request", () => {
  it("reveals the parent again when the active file is explicitly reopened", () => {
    const openedPaths: string[] = [];
    const consumedRequestIds: number[] = [];
    const loadedDirectories: string[] = [];
    let expandedDirectories: Record<string, boolean> = { src: true };
    const setExpandedDirectories: Dispatch<SetStateAction<Record<string, boolean>>> = (update) => {
      expandedDirectories = typeof update === "function" ? update(expandedDirectories) : update;
    };
    const applyRequest = (requestId: number) =>
      applyFileOpenRequest({
        request: {
          path: "src/index.ts",
          position: null,
          requestId,
        },
        directoryStateByPath: { src: {} },
        loadDirectory: (path) => {
          loadedDirectories.push(path);
        },
        setExpandedDirectories,
        openPreview: (entry) => {
          openedPaths.push(entry.path);
        },
        consumeRequest: (consumedRequestId) => {
          consumedRequestIds.push(consumedRequestId);
        },
      });

    applyRequest(1);
    expandedDirectories = { src: false };
    applyRequest(2);

    expect(expandedDirectories).toEqual({ src: true });
    expect(openedPaths).toEqual(["src/index.ts", "src/index.ts"]);
    expect(consumedRequestIds).toEqual([1, 2]);
    expect(loadedDirectories).toEqual([]);
  });
});
