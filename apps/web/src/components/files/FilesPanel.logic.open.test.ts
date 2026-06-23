import type { ProjectEntry } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { openFilesPanelEntry } from "./FilesPanel.logic";

const openNewBrowserTabMock = vi.fn();

vi.mock("../../stores/browser/browserPanel.actions", () => ({
  openNewBrowserTab: (...args: unknown[]) => openNewBrowserTabMock(...args),
}));

describe("openFilesPanelEntry", () => {
  it("opens workspace images in the browser panel by default", () => {
    openNewBrowserTabMock.mockReset();
    const setPreviewPath = vi.fn();
    const setPreviewPosition = vi.fn();

    openFilesPanelEntry(
      { path: "assets/logo.png", kind: "file" } satisfies ProjectEntry,
      "/Users/alice/project",
      setPreviewPath,
      setPreviewPosition,
    );

    expect(openNewBrowserTabMock).toHaveBeenCalledWith({
      url: expect.stringContaining("/api/workspace-file-preview?"),
    });
    expect(setPreviewPath).not.toHaveBeenCalled();
  });
});
