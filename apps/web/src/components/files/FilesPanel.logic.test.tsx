import type { ProjectEntry } from "@bigbud/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
