import type { ProjectEntry } from "@bigbud/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DirectoryState } from "./FilesPanel.shared";
import { renderFilesPanelTree } from "./FilesPanel.tree";

function makeDirectoryState(
  entries: ReadonlyArray<ProjectEntry>,
  loading: boolean,
): DirectoryState {
  return {
    entries,
    loading,
    error: null,
  };
}

describe("renderFilesPanelTree", () => {
  it("keeps cached nested entries visible during background refresh", () => {
    const markup = renderToStaticMarkup(
      <div>
        {renderFilesPanelTree({
          entries: [{ path: "docs", kind: "directory" }],
          depth: 0,
          workspaceRoot: "/tmp/workspace",
          previewPath: null,
          resolvedTheme: "dark",
          expandedDirectories: { docs: true },
          directoryStateByPath: {
            docs: makeDirectoryState(
              [{ path: "docs/readme.md", kind: "file", parentPath: "docs" }],
              true,
            ),
          },
          onToggleDirectory: () => undefined,
          onOpenFile: () => undefined,
          onOpenContextMenu: () => undefined,
        })}
      </div>,
    );

    expect(markup).toContain("readme.md");
    expect(markup).not.toContain("Loading...");
  });

  it("shows nested loading placeholder on first load without cached entries", () => {
    const markup = renderToStaticMarkup(
      <div>
        {renderFilesPanelTree({
          entries: [{ path: "docs", kind: "directory" }],
          depth: 0,
          workspaceRoot: "/tmp/workspace",
          previewPath: null,
          resolvedTheme: "dark",
          expandedDirectories: { docs: true },
          directoryStateByPath: {
            docs: makeDirectoryState([], true),
          },
          onToggleDirectory: () => undefined,
          onOpenFile: () => undefined,
          onOpenContextMenu: () => undefined,
        })}
      </div>,
    );

    expect(markup).toContain("Loading...");
  });
});
