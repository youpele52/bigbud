import { describe, expect, it, vi } from "vitest";

import {
  BIGBUD_FILES_PANEL_DRAG_MIME,
  joinWorkspaceEntryPath,
  writeFilesPanelDragEntry,
} from "./filesPanel.dnd";

describe("writeFilesPanelDragEntry", () => {
  it("writes the shared entry payload and plain-text path as a copy", () => {
    const setData = vi.fn();
    const dataTransfer = { effectAllowed: "none", setData } as unknown as DataTransfer;

    writeFilesPanelDragEntry(dataTransfer, {
      name: "file.md",
      path: "/workspace/docs/file.md",
      entryKind: "file",
    });

    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(setData).toHaveBeenNthCalledWith(
      1,
      BIGBUD_FILES_PANEL_DRAG_MIME,
      JSON.stringify({
        name: "file.md",
        path: "/workspace/docs/file.md",
        entryKind: "file",
      }),
    );
    expect(setData).toHaveBeenNthCalledWith(2, "text/plain", "/workspace/docs/file.md");
  });
});

describe("joinWorkspaceEntryPath", () => {
  it("joins a workspace root with a relative path", () => {
    expect(joinWorkspaceEntryPath("/Users/alice/project", "src/index.ts")).toBe(
      "/Users/alice/project/src/index.ts",
    );
  });

  it("collapses duplicate slashes from a trailing slash on the root", () => {
    expect(joinWorkspaceEntryPath("/Users/alice/project/", "src/index.ts")).toBe(
      "/Users/alice/project/src/index.ts",
    );
    expect(joinWorkspaceEntryPath("/Users/alice/project//", "src/index.ts")).toBe(
      "/Users/alice/project/src/index.ts",
    );
  });

  it("strips leading slashes from the relative path", () => {
    expect(joinWorkspaceEntryPath("/Users/alice/project", "/src/index.ts")).toBe(
      "/Users/alice/project/src/index.ts",
    );
    expect(joinWorkspaceEntryPath("/Users/alice/project", "////src/index.ts")).toBe(
      "/Users/alice/project/src/index.ts",
    );
  });

  it("handles nested relative paths", () => {
    expect(joinWorkspaceEntryPath("/Users/alice/G Drive/Apply/Resumes", "index.html")).toBe(
      "/Users/alice/G Drive/Apply/Resumes/index.html",
    );
    expect(joinWorkspaceEntryPath("/Users/alice/G Drive/Apply/Resumes", "sub/file.html")).toBe(
      "/Users/alice/G Drive/Apply/Resumes/sub/file.html",
    );
  });

  it("returns the root unchanged when the relative path is empty", () => {
    expect(joinWorkspaceEntryPath("/Users/alice/project", "")).toBe("/Users/alice/project");
    expect(joinWorkspaceEntryPath("/Users/alice/project/", "")).toBe("/Users/alice/project");
  });

  it("falls back to the relative path when the workspace root is missing", () => {
    expect(joinWorkspaceEntryPath(null, "src/index.ts")).toBe("src/index.ts");
    expect(joinWorkspaceEntryPath(undefined, "src/index.ts")).toBe("src/index.ts");
    expect(joinWorkspaceEntryPath("", "src/index.ts")).toBe("src/index.ts");
  });

  it("always returns an absolute path when the workspace root is absolute", () => {
    const result = joinWorkspaceEntryPath("/Users/alice/G Drive/Apply/Resumes", "index.html");
    expect(result.startsWith("/")).toBe(true);
    expect(result).toBe("/Users/alice/G Drive/Apply/Resumes/index.html");
  });
});
