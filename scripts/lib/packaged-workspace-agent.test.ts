import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findPackagedWorkspaceAgent,
  validateCodeSignatureRequirement,
} from "./packaged-workspace-agent";

function createBinaryFixture(
  relativeDirectory: string,
  binaryName: string,
): { binaryPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "bigbud-packaged-agent-"));
  const directory = join(root, relativeDirectory);
  mkdirSync(directory, { recursive: true });
  const binaryPath = join(directory, binaryName);
  writeFileSync(binaryPath, "fixture");
  return { binaryPath, root };
}

describe("packaged workspace agent discovery", () => {
  it("finds the case-sensitive macOS Contents/Resources path", () => {
    const { binaryPath, root } = createBinaryFixture(
      "bigbud Preview.app/Contents/Resources/server/workspace-agent/bin",
      "bigbud-remote-agent",
    );

    expect(findPackagedWorkspaceAgent(root, "mac")).toBe(binaryPath);
    expect(findPackagedWorkspaceAgent(root, "linux")).toBeUndefined();
  });

  it.each(["linux", "win"] as const)("finds the lowercase %s resources path", (platform) => {
    const binaryName = platform === "win" ? "bigbud-remote-agent.exe" : "bigbud-remote-agent";
    const { binaryPath, root } = createBinaryFixture(
      "bigbud/resources/server/workspace-agent/bin",
      binaryName,
    );

    expect(findPackagedWorkspaceAgent(root, platform)).toBe(binaryPath);
  });

  it("requires an expected publisher for Windows signature checks", () => {
    expect(() => validateCodeSignatureRequirement("mac", true)).not.toThrow();
    expect(() => validateCodeSignatureRequirement("linux", false)).not.toThrow();
    expect(() => validateCodeSignatureRequirement("win", false)).not.toThrow();
    expect(() => validateCodeSignatureRequirement("linux", true)).toThrow(
      "--require-code-signature is not valid for Linux packages",
    );
    expect(() => validateCodeSignatureRequirement("win", true)).toThrow(
      "BIGBUD_WINDOWS_SIGNING_SUBJECT is required for Windows signature checks",
    );
    expect(() => validateCodeSignatureRequirement("win", true, "CN=bigbud")).not.toThrow();
  });
});
