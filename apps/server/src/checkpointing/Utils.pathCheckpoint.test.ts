import { describe, expect, it } from "vitest";

import { isValidWorkspaceRelativePath } from "./Utils.ts";

describe("isValidWorkspaceRelativePath", () => {
  it("accepts normal workspace-relative paths", () => {
    expect(isValidWorkspaceRelativePath("src/components/file.tsx")).toBe(true);
  });

  it.each([
    "",
    ".",
    "../outside",
    "src/../../outside",
    "/absolute",
    "C:\\absolute",
    ".git/config",
    "src/.git/config",
  ])("rejects unsafe path %s", (path) => {
    expect(isValidWorkspaceRelativePath(path)).toBe(false);
  });
});
