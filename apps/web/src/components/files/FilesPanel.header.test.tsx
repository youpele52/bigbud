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
    expect(markup).toContain('aria-label="Show file tree"');
    expect(markup).toContain('aria-controls="files-tree"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain(String(FolderLibraryIcon[0]?.[1].d));
  });

  it("keeps pin and active hide toggle in the main header while pinned", () => {
    const markup = renderToStaticMarkup(
      <FilesPanelHeader
        treeVisible
        pinned
        treeControl={{ "aria-expanded": true }}
        pinControl={{ onClick: () => {} }}
      />,
    );
    expect(markup).toContain('aria-label="Hide file tree"');
    expect(markup).toContain('aria-label="Unpin file tree"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("bg-accent");
    expect(markup).not.toContain("Close files tree");
  });

  it.each([false, true])("reuses the slanted sidebar pin styling when pinned is %s", (pinned) => {
    const markup = renderToStaticMarkup(
      <FilesPanelHeader
        pinned={pinned}
        treeControl={{}}
        pinControl={{ className: "existing-pin-control" }}
      />,
    );
    const pinMarkup = markup.match(
      /<button[^>]*aria-label="(?:Unpin file tree|Keep tree beside file)"[^>]*>[\s\S]*?<\/button>/,
    )?.[0];
    expect(pinMarkup).toBeDefined();
    expect(pinMarkup).toContain("existing-pin-control");
    expect(pinMarkup).toContain("rotate-45");
    expect(pinMarkup).toContain(`aria-pressed="${pinned}"`);
    expect(pinMarkup).not.toContain("lucide-pin-off");
    if (pinned) {
      expect(pinMarkup).toContain("fill-current");
      expect(pinMarkup).toContain("text-primary hover:text-primary/90 dark:text-primary");
    } else {
      expect(pinMarkup).toContain("text-muted-foreground hover:text-foreground");
      expect(pinMarkup).not.toContain("fill-current");
    }
  });
});
