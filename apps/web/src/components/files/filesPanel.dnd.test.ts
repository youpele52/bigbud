import { describe, expect, it } from "vitest";

import { joinWorkspaceEntryPath } from "./filesPanel.dnd";

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
