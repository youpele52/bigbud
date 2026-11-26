import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findStandaloneSshOwnerTarget,
  locateStandaloneSshOwnerExecutable,
  standaloneSshOwnerRelativePath,
} from "./sshOwnerExecutable.ts";

describe("standalone SSH owner discovery (U4 N)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), "ssh-owner-discovery-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function touch(path: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "owner", { mode: 0o755 });
  }

  it("covers exactly the U4 N cells", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
      ["win32", "x64"],
    ] as const) {
      expect(findStandaloneSshOwnerTarget(platform, arch)).toMatchObject({ platform, arch });
    }
    expect(findStandaloneSshOwnerTarget("win32", "arm64")).toBeUndefined();
    expect(findStandaloneSshOwnerTarget("linux", "ia32")).toBeUndefined();
  });

  it("prefers the packaged member over a checkout build", async () => {
    const distDirectory = join(root, "dist");
    const target = findStandaloneSshOwnerTarget("linux", "x64")!;
    const packaged = join(distDirectory, standaloneSshOwnerRelativePath(target));
    expect(packaged).toBe(join(distDirectory, "ssh-owner", "linux-x64", "bigbud-ssh-owner"));
    await touch(packaged);
    await touch(join(root, "target", "release", "bigbud-ssh-owner"));
    await expect(
      locateStandaloneSshOwnerExecutable({
        distDirectory,
        repoRoot: root,
        platform: "linux",
        arch: "x64",
      }),
    ).resolves.toEqual({ kind: "packaged", path: packaged, target });
  });

  it("falls back to the checkout release build only when a repo root is given", async () => {
    const distDirectory = join(root, "dist");
    const dev = join(root, "target", "release", "bigbud-ssh-owner.exe");
    await touch(dev);
    const input = { distDirectory, platform: "win32", arch: "x64" } as const;
    await expect(
      locateStandaloneSshOwnerExecutable({ ...input, repoRoot: root }),
    ).resolves.toMatchObject({ kind: "dev", path: dev });
    await expect(locateStandaloneSshOwnerExecutable(input)).resolves.toEqual({
      kind: "missing",
      reason: "missingAsset",
      candidates: [join(distDirectory, "ssh-owner", "win32-x64", "bigbud-ssh-owner.exe")],
    });
  });

  it("returns a typed missing result instead of searching elsewhere", async () => {
    await expect(
      locateStandaloneSshOwnerExecutable({
        distDirectory: join(root, "dist"),
        repoRoot: root,
        platform: "darwin",
        arch: "arm64",
      }),
    ).resolves.toMatchObject({ kind: "missing", reason: "missingAsset" });
    await expect(
      locateStandaloneSshOwnerExecutable({
        distDirectory: join(root, "dist"),
        platform: "win32",
        arch: "arm64",
      }),
    ).resolves.toEqual({ kind: "missing", reason: "unsupportedTarget", candidates: [] });
  });

  it("does not accept a directory at the member path", async () => {
    const distDirectory = join(root, "dist");
    await mkdir(join(distDirectory, "ssh-owner", "linux-arm64", "bigbud-ssh-owner"), {
      recursive: true,
    });
    await expect(
      locateStandaloneSshOwnerExecutable({ distDirectory, platform: "linux", arch: "arm64" }),
    ).resolves.toMatchObject({ kind: "missing", reason: "missingAsset" });
  });
});
