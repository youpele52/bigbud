import { describe, expect, it } from "vitest";

import { buildWorkspaceFilePreviewUrl } from "../../lib/workspaceFilePreview";
import { parsePathPositionSuffix } from "../../models/editor";
import { useBrowserPanelStore } from "../browser/browser.store";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useFilesPanelStore } from "./filesPanel.store";
import {
  canOpenPathInBrowserPanel,
  canOpenPathInternally,
  canOpenDirectoryInFilesPanel,
  canOpenPathInFilesPanel,
  openDirectoryInFilesPanelIfSupported,
  openPathInBrowserPanelIfSupported,
  openPathInFilesPanelIfSupported,
  resolveWorkspaceRelativeEntryPath,
} from "./filesPanel.open";

function resetFilesPanelState() {
  useBrowserPanelStore.setState({
    open: false,
    tabsById: {},
  });
  useFilesPanelStore.setState({
    open: false,
    previewPath: null,
    previewPosition: null,
    fileOpenRequest: null,
    directoryNavigationRequest: null,
  });
  useRightPanelTabsStore.setState({ activeKind: null, activeTabId: null, openTabs: [] });
}

describe("parsePathPositionSuffix", () => {
  it("extracts line and column from a file path suffix", () => {
    expect(parsePathPositionSuffix("/Users/alice/project/src/index.ts:16:23")).toEqual({
      line: 16,
      column: 23,
    });
  });

  it("extracts line without a column", () => {
    expect(parsePathPositionSuffix("/Users/alice/project/src/index.ts:16")).toEqual({
      line: 16,
      column: null,
    });
  });

  it("returns null when no position suffix is present", () => {
    expect(parsePathPositionSuffix("/Users/alice/project/src/index.ts")).toBeNull();
  });
});

describe("resolveWorkspaceRelativeEntryPath", () => {
  it("maps a workspace file path to a relative preview path", () => {
    expect(
      resolveWorkspaceRelativeEntryPath(
        "/Users/alice/project/src/index.ts",
        "/Users/alice/project",
      ),
    ).toBe("src/index.ts");
  });

  it("strips line and column suffixes before opening in the viewer", () => {
    expect(
      resolveWorkspaceRelativeEntryPath(
        "/Users/alice/project/src/index.ts:16:23",
        "/Users/alice/project",
      ),
    ).toBe("src/index.ts");
  });

  it("rejects files outside the current workspace", () => {
    expect(
      resolveWorkspaceRelativeEntryPath(
        "/Users/alice/other-project/src/index.ts",
        "/Users/alice/project",
      ),
    ).toBeNull();
  });

  it("handles windows paths case-insensitively", () => {
    expect(
      resolveWorkspaceRelativeEntryPath(
        "C:\\Users\\Alice\\Project\\src\\index.ts:8",
        "C:\\Users\\alice\\project",
      ),
    ).toBe("src/index.ts");
  });
});

describe("canOpenPathInFilesPanel", () => {
  it("allows previewable workspace files", () => {
    expect(canOpenPathInFilesPanel("/Users/alice/project/README.md", "/Users/alice/project")).toBe(
      true,
    );
  });

  it("rejects unsupported files even when they are in the workspace", () => {
    expect(canOpenPathInFilesPanel("/Users/alice/project/logo.png", "/Users/alice/project")).toBe(
      true,
    );
  });
});

describe("canOpenPathInBrowserPanel", () => {
  it("allows workspace PDFs", () => {
    expect(
      canOpenPathInBrowserPanel("/Users/alice/project/docs/report.pdf", "/Users/alice/project"),
    ).toBe(true);
  });

  it("allows workspace images", () => {
    expect(
      canOpenPathInBrowserPanel("/Users/alice/project/assets/logo.png", "/Users/alice/project"),
    ).toBe(true);
  });

  it("rejects non-previewable workspace files", () => {
    expect(
      canOpenPathInBrowserPanel("/Users/alice/project/README.md", "/Users/alice/project"),
    ).toBe(false);
  });
});

describe("canOpenPathInternally", () => {
  it("allows files panel previews", () => {
    expect(canOpenPathInternally("/Users/alice/project/README.md", "/Users/alice/project")).toBe(
      true,
    );
  });

  it("allows browser panel PDF previews", () => {
    expect(
      canOpenPathInternally("/Users/alice/project/docs/report.pdf", "/Users/alice/project"),
    ).toBe(true);
  });

  it("allows image previews in the files panel", () => {
    expect(canOpenPathInternally("/Users/alice/project/logo.png", "/Users/alice/project")).toBe(
      true,
    );
  });
});

describe("canOpenDirectoryInFilesPanel", () => {
  it("allows workspace directories", () => {
    expect(canOpenDirectoryInFilesPanel("/Users/alice/project/src", "/Users/alice/project")).toBe(
      true,
    );
  });

  it("rejects directories outside the workspace", () => {
    expect(canOpenDirectoryInFilesPanel("/Users/alice/other/src", "/Users/alice/project")).toBe(
      false,
    );
  });
});

describe("openPathInBrowserPanelIfSupported", () => {
  it("opens workspace PDFs in the browser panel", () => {
    resetFilesPanelState();

    expect(
      openPathInBrowserPanelIfSupported(
        "/Users/alice/project/docs/report.pdf",
        "/Users/alice/project",
      ),
    ).toBe(true);

    const browserTabIds = Object.keys(useBrowserPanelStore.getState().tabsById);
    expect(useBrowserPanelStore.getState()).toMatchObject({
      open: true,
      tabsById: {
        [browserTabIds[0] ?? ""]: {
          url: expect.stringContaining("/api/workspace-pdf-viewer?"),
        },
      },
    });
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      openTabs: browserTabIds,
    });
  });

  it("uses the HTML wrapper outside desktop runtimes", () => {
    expect(
      buildWorkspaceFilePreviewUrl({
        cwd: "/Users/alice/project",
        relativePath: "docs/report.pdf",
      }),
    ).toContain("/api/workspace-pdf-viewer?");
  });

  it("uses the raw PDF route when a desktop bridge is available", () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getWsUrl: () => "ws://127.0.0.1:3773/?token=test",
        },
        location: { origin: "http://127.0.0.1:5173" },
      },
    });

    try {
      expect(
        buildWorkspaceFilePreviewUrl({
          cwd: "/Users/alice/project",
          relativePath: "docs/report.pdf",
        }),
      ).toContain("/api/workspace-file-preview?");
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("opens each PDF in a separate browser tab up to the browser tab limit", () => {
    resetFilesPanelState();

    for (let index = 0; index < 5; index += 1) {
      expect(
        openPathInBrowserPanelIfSupported(
          `/Users/alice/project/docs/report-${index}.pdf`,
          "/Users/alice/project",
        ),
      ).toBe(true);
    }

    const browserTabIds = Object.keys(useBrowserPanelStore.getState().tabsById);
    expect(browserTabIds).toHaveLength(5);
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(browserTabIds);
    expect(Object.values(useBrowserPanelStore.getState().tabsById).map((tab) => tab.url)).toEqual([
      expect.stringContaining("report-0.pdf"),
      expect.stringContaining("report-1.pdf"),
      expect.stringContaining("report-2.pdf"),
      expect.stringContaining("report-3.pdf"),
      expect.stringContaining("report-4.pdf"),
    ]);
  });

  it("opens workspace images in the browser panel", () => {
    resetFilesPanelState();

    expect(
      openPathInBrowserPanelIfSupported(
        "/Users/alice/project/assets/logo.png",
        "/Users/alice/project",
      ),
    ).toBe(true);

    const browserTabIds = Object.keys(useBrowserPanelStore.getState().tabsById);
    expect(useBrowserPanelStore.getState()).toMatchObject({
      open: true,
      tabsById: {
        [browserTabIds[0] ?? ""]: {
          url: expect.stringContaining("/api/workspace-file-preview?"),
        },
      },
    });
  });
});

describe("openPathInFilesPanelIfSupported", () => {
  it("opens the files tab with the parsed preview position", () => {
    resetFilesPanelState();

    expect(
      openPathInFilesPanelIfSupported(
        "/Users/alice/project/src/index.ts:16:23",
        "/Users/alice/project",
      ),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      fileOpenRequest: {
        path: "src/index.ts",
        position: { line: 16, column: 23 },
        requestId: 1,
      },
    });
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "files",
      openTabs: ["files"],
    });
  });

  it("clears any previous preview position when opening a plain file path", () => {
    resetFilesPanelState();
    useFilesPanelStore.setState({
      open: true,
      previewPath: "src/old.ts",
      previewPosition: { line: 9, column: 2 },
      fileOpenRequest: null,
    });

    expect(
      openPathInFilesPanelIfSupported("/Users/alice/project/src/new.ts", "/Users/alice/project"),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      fileOpenRequest: {
        path: "src/new.ts",
        position: null,
        requestId: 1,
      },
    });
  });

  it("opens workspace images in the files panel", () => {
    resetFilesPanelState();

    expect(
      openPathInFilesPanelIfSupported(
        "/Users/alice/project/assets/logo.png",
        "/Users/alice/project",
      ),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      fileOpenRequest: {
        path: "assets/logo.png",
        position: null,
        requestId: 1,
      },
    });
  });
});

describe("openDirectoryInFilesPanelIfSupported", () => {
  it("opens the files tab and requests directory navigation", () => {
    resetFilesPanelState();

    expect(
      openDirectoryInFilesPanelIfSupported("/Users/alice/project/src/lib", "/Users/alice/project"),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      previewPath: null,
      previewPosition: null,
      fileOpenRequest: null,
      directoryNavigationRequest: {
        path: "src/lib",
        requestId: 1,
      },
    });
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "files",
      openTabs: ["files"],
    });
  });
});
