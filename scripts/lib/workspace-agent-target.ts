import { readFileSync } from "node:fs";

export const WORKSPACE_AGENT_TARGETS = [
  {
    buildPlatform: "mac",
    platform: "darwin",
    arch: "arm64",
    rustOs: "macos",
    rustArch: "aarch64",
    rustTarget: "aarch64-apple-darwin",
  },
  {
    buildPlatform: "mac",
    platform: "darwin",
    arch: "x64",
    rustOs: "macos",
    rustArch: "x86_64",
    rustTarget: "x86_64-apple-darwin",
  },
  {
    buildPlatform: "linux",
    platform: "linux",
    arch: "x64",
    rustOs: "linux",
    rustArch: "x86_64",
    rustTarget: "x86_64-unknown-linux-gnu",
  },
  {
    buildPlatform: "win",
    platform: "win32",
    arch: "x64",
    rustOs: "windows",
    rustArch: "x86_64",
    rustTarget: "x86_64-pc-windows-msvc",
  },
] as const;

export type WorkspaceAgentTarget = (typeof WORKSPACE_AGENT_TARGETS)[number];

export function workspaceAgentBinaryName(platform: WorkspaceAgentTarget["platform"]): string {
  return platform === "win32" ? "bigbud-remote-agent.exe" : "bigbud-remote-agent";
}

export function findWorkspaceAgentTarget(
  platform: NodeJS.Platform,
  arch: string,
): WorkspaceAgentTarget | undefined {
  return WORKSPACE_AGENT_TARGETS.find(
    (target) => target.platform === platform && target.arch === arch,
  );
}

export function findDesktopWorkspaceAgentTarget(
  platform: WorkspaceAgentTarget["buildPlatform"],
  arch: string,
): WorkspaceAgentTarget | undefined {
  return WORKSPACE_AGENT_TARGETS.find(
    (target) => target.buildPlatform === platform && target.arch === arch,
  );
}

export function assertWorkspaceAgentArtifactTarget(
  path: string,
  target: WorkspaceAgentTarget,
): void {
  const bytes = readFileSync(path);
  let matches = false;
  if (target.platform === "linux") {
    matches =
      bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      bytes[4] === 2 &&
      bytes.readUInt16LE(18) === 0x3e;
  } else if (target.platform === "darwin") {
    const cpuType = bytes.length >= 8 ? bytes.readUInt32LE(4) : 0;
    matches =
      bytes.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) &&
      ((target.arch === "arm64" && cpuType === 0x0100000c) ||
        (target.arch === "x64" && cpuType === 0x01000007));
  } else if (bytes.subarray(0, 2).toString("ascii") === "MZ") {
    const peOffset = bytes.length >= 0x40 ? bytes.readUInt32LE(0x3c) : 0;
    matches =
      peOffset + 6 <= bytes.length &&
      bytes.subarray(peOffset, peOffset + 4).toString("binary") === "PE\0\0" &&
      bytes.readUInt16LE(peOffset + 4) === 0x8664;
  }
  if (!matches) {
    throw new Error(
      `Workspace watcher artifact target mismatch: ${target.platform}/${target.arch}`,
    );
  }
}
