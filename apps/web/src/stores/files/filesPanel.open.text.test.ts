import { describe, expect, it } from "vitest";

import { canOpenPathInFilesPanel } from "./filesPanel.open";

describe("canOpenPathInFilesPanel text files", () => {
  it("allows extensionless and dotfiles in the workspace", () => {
    const workspaceRoot = "/Users/alice/project";

    for (const relativePath of [
      "Dockerfile.prod",
      "Dockerfile.dev",
      ".env.example",
      ".gitattributes",
    ]) {
      expect(canOpenPathInFilesPanel(`${workspaceRoot}/${relativePath}`, workspaceRoot)).toBe(true);
    }
  });
});
