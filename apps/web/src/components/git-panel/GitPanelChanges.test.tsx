import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GitStatusResult } from "@bigbud/contracts";

vi.mock("~/stores/files/filesPanel.coordinator", () => ({
  openFileInFilesPanel: vi.fn(),
}));

vi.mock("./GitPatchViewer", () => ({
  GitPatchViewer: () => <div data-testid="git-patch-viewer" />,
}));

vi.mock("./GitPanelSplitView", () => ({
  GitPanelSplitView: ({ sidebar, main }: { sidebar: React.ReactNode; main: React.ReactNode }) => (
    <div>
      <div data-testid="sidebar">{sidebar}</div>
      <div data-testid="main">{main}</div>
    </div>
  ),
}));

import { GitPanelChanges } from "./GitPanelChanges";

const gitStatus: GitStatusResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: true,
  branch: "dev",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "docs/CHANGELOG.md", insertions: 53, deletions: 0 }],
    insertions: 53,
    deletions: 0,
  },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

describe("GitPanelChanges", () => {
  it("marks changed file paths so clicks can open the files panel", () => {
    const html = renderToStaticMarkup(
      <GitPanelChanges
        diffError={null}
        diffPatch=""
        gitStatus={gitStatus}
        isLoadingDiff={false}
        onSelectFile={vi.fn()}
        selectedFilePath="docs/CHANGELOG.md"
        workspaceRoot="/repo/project"
      />,
    );

    expect(html).toContain('data-git-file-path="true"');
    expect(html).toContain("docs/CHANGELOG.md");
    expect(html).toContain("hover:underline");
  });
});
