import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertWorkspaceAgentArtifactTarget,
  findDesktopWorkspaceAgentTarget,
  findWorkspaceAgentTarget,
} from "./workspace-agent-target.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function elf64(machine: number): string {
  const directory = mkdtempSync(join(tmpdir(), "bigbud-agent-target-"));
  directories.push(directory);
  const bytes = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(machine, 18);
  const path = join(directory, "bigbud-remote-agent");
  writeFileSync(path, bytes);
  return path;
}

describe("workspace agent targets", () => {
  it("maps linux/arm64 to the native aarch64 Linux agent", () => {
    expect(findWorkspaceAgentTarget("linux", "arm64")).toMatchObject({
      rustOs: "linux",
      rustArch: "aarch64",
      rustTarget: "aarch64-unknown-linux-gnu",
    });
    expect(findDesktopWorkspaceAgentTarget("linux", "x64")?.rustArch).toBe("x86_64");
  });

  it("checks the ELF machine for each Linux architecture", () => {
    const arm64 = findWorkspaceAgentTarget("linux", "arm64")!;
    const x64 = findWorkspaceAgentTarget("linux", "x64")!;
    const aarch64Binary = elf64(0xb7);
    const x8664Binary = elf64(0x3e);

    expect(() => assertWorkspaceAgentArtifactTarget(aarch64Binary, arm64)).not.toThrow();
    expect(() => assertWorkspaceAgentArtifactTarget(x8664Binary, x64)).not.toThrow();
    expect(() => assertWorkspaceAgentArtifactTarget(x8664Binary, arm64)).toThrow(
      "Workspace watcher artifact target mismatch: linux/arm64",
    );
    expect(() => assertWorkspaceAgentArtifactTarget(aarch64Binary, x64)).toThrow(
      "Workspace watcher artifact target mismatch: linux/x64",
    );
  });
});
