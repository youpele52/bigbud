import { describe, expect, it } from "vitest";

import { buildFilePreviewWatchInput } from "./useFilePreviewRefresh";

describe("buildFilePreviewWatchInput", () => {
  it("watches the workspace root for root-level files", () => {
    expect(
      buildFilePreviewWatchInput({
        cwd: "/workspace",
        relativePath: "CHANGELOG.md",
      }),
    ).toEqual({ cwd: "/workspace" });
  });

  it("watches the parent directory for nested files", () => {
    expect(
      buildFilePreviewWatchInput({
        cwd: "/workspace",
        relativePath: "docs/CHANGELOG.md",
      }),
    ).toEqual({ cwd: "/workspace", relativePath: "docs" });
  });

  it("preserves the execution target when building the watch input", () => {
    expect(
      buildFilePreviewWatchInput({
        cwd: "/workspace",
        relativePath: "docs/CHANGELOG.md",
        executionTargetId: "local:workspace",
      }),
    ).toEqual({
      cwd: "/workspace",
      relativePath: "docs",
      executionTargetId: "local:workspace",
    });
  });
});
