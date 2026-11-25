import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type StandaloneSshOwnerExecutableInput,
  verifyStandaloneSshOwnerExecutable,
} from "./sshOwnerExecutable.ts";

type Platform = "darwin" | "linux" | "win32";
type Arch = "arm64" | "x64";

// These fixtures exercise the read-only header check, not native loader compatibility.
function nativeHeader(platform: Platform, arch: Arch): Buffer {
  const bytes = Buffer.alloc(512);
  const arm64 = arch === "arm64";
  if (platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arm64 ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(2, 12);
  } else if (platform === "linux") {
    bytes.writeUInt32BE(0x7f454c46, 0);
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(3, 16);
    bytes.writeUInt16LE(arm64 ? 0xb7 : 0x3e, 18);
  } else {
    const peOffset = 128;
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(peOffset, 0x3c);
    bytes.writeUInt32LE(0x00004550, peOffset);
    bytes.writeUInt16LE(arm64 ? 0xaa64 : 0x8664, peOffset + 4);
    bytes.writeUInt16LE(240, peOffset + 20);
    bytes.writeUInt16LE(0x0002, peOffset + 22);
    bytes.writeUInt16LE(0x020b, peOffset + 24);
  }
  return bytes;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("standalone SSH owner executable verification", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), "ssh-owner-executable-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function stage(platform: Platform, arch: Arch, bytes = nativeHeader(platform, arch)) {
    const distDirectory = join(root, "dist");
    const filename = platform === "win32" ? "bigbud-ssh-owner.exe" : "bigbud-ssh-owner";
    const relativePath = `ssh-owner/${platform}-${arch}/${filename}`;
    const path = join(distDirectory, relativePath);
    const input: StandaloneSshOwnerExecutableInput = {
      distDirectory,
      platform,
      arch,
      trustedManifestEntry: {
        platform,
        arch,
        relativePath,
        sizeBytes: bytes.length,
        sha256: digest(bytes),
      },
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o755 });
    return { input, path };
  }

  it.each([
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
    ["win32", "arm64"],
    ["win32", "x64"],
  ] as const)(
    "verifies the exact %s/%s package member without running it",
    async (platform, arch) => {
      const { input, path } = await stage(platform, arch);
      await expect(verifyStandaloneSshOwnerExecutable(input)).resolves.toBe(path);
    },
  );

  it("rejects an unsupported runtime and a manifest for another target", async () => {
    const { input } = await stage("linux", "x64");
    await expect(
      verifyStandaloneSshOwnerExecutable({ ...input, arch: "ia32" }),
    ).rejects.toMatchObject({
      reason: "unsupportedTarget",
    });
    for (const runtime of [{ arch: "arm64" }, { platform: "darwin" as const }]) {
      await expect(
        verifyStandaloneSshOwnerExecutable({ ...input, ...runtime }),
      ).rejects.toMatchObject({
        reason: "manifestMismatch",
      });
    }
  });

  it("rejects traversal, neighboring filenames, and invalid manifest pins", async () => {
    const { input } = await stage("win32", "x64");
    for (const override of [
      { relativePath: "ssh-owner/win32-x64/../bigbud-ssh-owner.exe" },
      { relativePath: "ssh-owner/win32-x64/bigbud-ssh-owner" },
      { relativePath: "ssh-owner/win32-x64/bigbud-ssh-owner.exe:alternate" },
      { sha256: "not-a-checksum" },
      { sizeBytes: 2 ** 30 },
    ]) {
      await expect(
        verifyStandaloneSshOwnerExecutable({
          ...input,
          trustedManifestEntry: { ...input.trustedManifestEntry, ...override },
        }),
      ).rejects.toMatchObject({ reason: "manifestMismatch" });
    }
    await expect(
      verifyStandaloneSshOwnerExecutable({ ...input, distDirectory: "dist" }),
    ).rejects.toMatchObject({
      reason: "unsafePath",
    });
  });

  it.each([
    ["darwin", nativeHeader("darwin", "arm64")],
    ["linux", nativeHeader("darwin", "x64")],
    ["win32", nativeHeader("win32", "arm64")],
    ["win32", nativeHeader("win32", "x64").subarray(0, 129)],
  ] as const)(
    "rejects incompatible or truncated %s bytes even when pinned",
    async (platform, bytes) => {
      const { input } = await stage(platform, "x64", bytes);
      await expect(verifyStandaloneSshOwnerExecutable(input)).rejects.toMatchObject({
        reason: "invalidTarget",
      });
    },
  );

  it("ignores a nearby checksum matching a same-size replacement", async () => {
    const bytes = Buffer.alloc(130 * 1024);
    nativeHeader("linux", "x64").copy(bytes);
    const { input, path } = await stage("linux", "x64", bytes);
    await expect(verifyStandaloneSshOwnerExecutable(input)).resolves.toBe(path);

    const replacement = Buffer.from(bytes);
    replacement[replacement.length - 1] = 1;
    await writeFile(path, replacement);
    await writeFile(`${path}.sha256`, `${digest(replacement)}\n`);
    await expect(verifyStandaloneSshOwnerExecutable(input)).rejects.toMatchObject({
      reason: "integrityMismatch",
    });
  });

  it("does not fall back to another image when the exact asset is missing", async () => {
    const { input, path } = await stage("linux", "x64");
    await rename(path, join(input.distDirectory, "bigbud-ssh-owner"));
    await expect(verifyStandaloneSshOwnerExecutable(input)).rejects.toMatchObject({
      reason: "missingAsset",
    });
  });

  it("rejects a linked ancestor even if it leads to the exact pinned bytes", async () => {
    const { input } = await stage("linux", "x64");
    await rename(join(input.distDirectory, "ssh-owner"), join(root, "real-owner"));
    await symlink(join(root, "real-owner"), join(input.distDirectory, "ssh-owner"), "junction");
    await expect(verifyStandaloneSshOwnerExecutable(input)).rejects.toMatchObject({
      reason: "unsafePath",
    });
  });

  it("rejects hard-linked executable bytes", async () => {
    const { input, path } = await stage("linux", "x64");
    await link(path, join(root, "second-name"));
    await expect(verifyStandaloneSshOwnerExecutable(input)).rejects.toMatchObject({
      reason: "unsafePath",
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a final symlink to the pinned image",
    async () => {
      const { input, path } = await stage("linux", "x64");
      const actual = join(root, "actual-owner");
      await rename(path, actual);
      await symlink(actual, path);
      await expect(verifyStandaloneSshOwnerExecutable(input)).rejects.toMatchObject({
        reason: "unsafePath",
      });
    },
  );

  it.skipIf(process.platform === "win32")("rejects a non-executable POSIX file", async () => {
    const { input, path } = await stage("linux", "x64");
    await chmod(path, 0o644);
    await expect(verifyStandaloneSshOwnerExecutable(input)).rejects.toMatchObject({
      reason: "unsafePath",
    });
  });
});
