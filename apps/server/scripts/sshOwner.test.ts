import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SSH_OWNER_RELEASE_TARGETS,
  sshOwnerReleaseAssetName,
  type SshOwnerDesktopTarget,
} from "../../../scripts/lib/packaged-ssh-owner.ts";
import {
  assertCompleteServerSshOwnerSet,
  serverSshOwnerPath,
  stageReleasedServerSshOwners,
} from "./sshOwner.ts";

const repoRoot = join(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function header(target: SshOwnerDesktopTarget): Buffer {
  const bytes = Buffer.alloc(256);
  if (target.platform === "linux") {
    bytes.writeUInt32BE(0x7f454c46, 0);
    bytes[4] = 2;
    bytes.writeUInt16LE(target.arch === "arm64" ? 0xb7 : 0x3e, 18);
  } else if (target.platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target.arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  } else {
    bytes.write("MZ");
    bytes.writeUInt32LE(64, 0x3c);
    bytes.write("PE\0\0", 64, "binary");
    bytes.writeUInt16LE(0x8664, 68);
  }
  return bytes;
}

function releaseRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bigbud-ssh-owner-package-"));
  roots.push(root);
  mkdirSync(join(root, "release-assets"));
  for (const target of SSH_OWNER_RELEASE_TARGETS) {
    writeFileSync(join(root, "release-assets", sshOwnerReleaseAssetName(target)), header(target));
  }
  return root;
}

describe("standalone N SSH owner packaging", () => {
  it("ships exactly the U4 N cells", () => {
    expect(SSH_OWNER_RELEASE_TARGETS.map(sshOwnerReleaseAssetName)).toEqual([
      "server-ssh-owner-darwin-arm64",
      "server-ssh-owner-darwin-x64",
      "server-ssh-owner-linux-x64",
      "server-ssh-owner-linux-arm64",
      "server-ssh-owner-win32-x64.exe",
    ]);
  });

  it("stages every released owner at the path the runtime verifier expects", () => {
    const root = releaseRoot();
    const serverDir = join(root, "server");
    stageReleasedServerSshOwners(root, serverDir);
    assertCompleteServerSshOwnerSet(serverDir);
    const linux = SSH_OWNER_RELEASE_TARGETS.find((target) => target.platform === "linux")!;
    const path = serverSshOwnerPath(serverDir, linux);
    expect(path).toBe(join(serverDir, "dist", "ssh-owner", "linux-x64", "bigbud-ssh-owner"));
    if (process.platform !== "win32") expect(statSync(path).mode & 0o111).not.toBe(0);
  });

  it("refuses to publish with a missing or wrong-architecture owner", () => {
    const root = releaseRoot();
    rmSync(join(root, "release-assets", "server-ssh-owner-linux-arm64"));
    expect(() => stageReleasedServerSshOwners(root, join(root, "server"))).toThrow();

    const swapped = releaseRoot();
    const intel = SSH_OWNER_RELEASE_TARGETS.find(
      (target) => target.platform === "darwin" && target.arch === "x64",
    )!;
    const arm = SSH_OWNER_RELEASE_TARGETS[0]!;
    writeFileSync(join(swapped, "release-assets", sshOwnerReleaseAssetName(intel)), header(arm));
    stageReleasedServerSshOwners(swapped, join(swapped, "server"));
    expect(() => assertCompleteServerSshOwnerSet(join(swapped, "server"))).toThrow(
      /target mismatch: darwin\/x64/,
    );
  });

  it("verifier refuses Windows arm64 and a missing package before running anything", () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["scripts/verify-packaged-ssh-owner.ts", ...args], {
        cwd: repoRoot,
        encoding: "utf8",
      });
    expect(run("--binary", "/nonexistent", "win", "arm64").stderr).toContain(
      "No SSH owner is shipped for win/arm64",
    );
    const empty = mkdtempSync(join(tmpdir(), "bigbud-ssh-owner-release-"));
    roots.push(empty);
    expect(run(empty, "linux", "x64").stderr).toContain("Packaged SSH owner not found");
    expect(run("--binary", "/x", "linux", "x64", "--require-code-signature").status).not.toBe(0);
  });
});
