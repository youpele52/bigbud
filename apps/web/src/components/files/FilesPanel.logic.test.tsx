import type { ProjectEntry } from "@bigbud/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { reconcilePreviewPathAfterDirectoryRefresh } from "./FilesPanel.logic";
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
  it("updates the preview path when a sibling file rename is unambiguous", () => {
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
    ).toBe("docs/changelog.md");
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
