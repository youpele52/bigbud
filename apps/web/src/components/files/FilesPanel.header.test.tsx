import { FolderLibraryIcon } from "@hugeicons/core-free-icons";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/config/env", () => ({ isElectron: true }));

import { FilesPanelHeader } from "./FilesPanel.header";

describe("FilesPanel top header", () => {
  it("keeps the title without a preview control", () => {
    const markup = renderToStaticMarkup(<FilesPanelHeader />);
    expect(markup).toContain("Files</p>");
    expect(markup).toContain("drag-region");
    expect(markup).not.toContain("<button");
  });

  it("renders FolderLibrary as an accessible no-drag icon in the drag-region header", () => {
    const markup = renderToStaticMarkup(
      <FilesPanelHeader
        treeControl={{
          "aria-controls": "files-tree",
          "aria-expanded": false,
          onClick: () => {},
        }}
      />,
    );
    expect(markup).toContain("drag-region");
    expect(markup).toContain("[-webkit-app-region:no-drag]");
    expect(markup).toContain('aria-label="Keep file tree open"');
    expect(markup).toContain('aria-controls="files-tree"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain(String(FolderLibraryIcon[0]?.[1].d));
  });

  it.each([false, true])("shows the keep-open toggle state when kept open is %s", (keptOpen) => {
    const markup = renderToStaticMarkup(
      <FilesPanelHeader keptOpen={keptOpen} treeControl={{ "aria-expanded": keptOpen }} />,
    );
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain(
      `aria-label="${keptOpen ? "Close file tree" : "Keep file tree open"}"`,
    );
    expect(markup).toContain(`aria-pressed="${keptOpen}"`);
    expect(markup.includes("bg-accent")).toBe(keptOpen);
    expect(markup).not.toContain("lucide-pin");
    expect(markup).not.toContain("Close files tree");
  });
});
