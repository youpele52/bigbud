import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { findWorkspaceAgentTarget } from "../../../../scripts/lib/workspace-agent-target.ts";
import { matchesSshOwnerExecutableTarget } from "./sshOwnerExecutable.header.ts";

const MAX_BYTES = 512 * 1024 * 1024;

export interface TrustedStandaloneSshOwnerManifestEntry {
  readonly platform: string;
  readonly arch: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface StandaloneSshOwnerExecutableInput {
  /** Canonical absolute path to the trusted standalone package's dist directory. */
  readonly distDirectory: string;
  /** Must come from a separately authenticated release manifest, not from the install tree. */
  readonly trustedManifestEntry: TrustedStandaloneSshOwnerManifestEntry;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

type Failure =
  | "unsupportedTarget"
  | "manifestMismatch"
  | "unsafePath"
  | "missingAsset"
  | "invalidTarget"
  | "integrityMismatch"
  | "unreadableAsset";

export class StandaloneSshOwnerExecutableError extends Error {
  readonly _tag = "StandaloneSshOwnerExecutableError";

  constructor(
    readonly reason: Failure,
    options?: ErrorOptions,
  ) {
    super(`Standalone SSH owner verification failed: ${reason}.`, options);
    this.name = "StandaloneSshOwnerExecutableError";
  }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

async function canonicalDirectory(path: string): Promise<BigIntStats> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || (await realpath(path)) !== path) {
    throw new StandaloneSshOwnerExecutableError("unsafePath");
  }
  return stat;
}

function assertSafeFile(stat: BigIntStats, checkPosixMode: boolean): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    (checkPosixMode && ((stat.mode & 0o111n) === 0n || (stat.mode & 0o6022n) !== 0n))
  ) {
    throw new StandaloneSshOwnerExecutableError("unsafePath");
  }
}

/**
 * Verify the exact target-specific member of a standalone installation. Never searches PATH,
 * honors environment overrides, reads neighboring checksums, or runs the image. This is a point-in-time
 * integrity check, not launch authorization; it does not fence later path replacement.
 */
export async function verifyStandaloneSshOwnerExecutable({
  distDirectory,
  trustedManifestEntry,
  platform = process.platform,
  arch = process.arch,
}: StandaloneSshOwnerExecutableInput): Promise<string> {
  const target = findWorkspaceAgentTarget(platform, arch);
  if (!target) throw new StandaloneSshOwnerExecutableError("unsupportedTarget");

  const targetDirectory = `${target.platform}-${target.arch}`;
  const filename = target.platform === "win32" ? "bigbud-ssh-owner.exe" : "bigbud-ssh-owner";
  const { relativePath, sha256, sizeBytes } = trustedManifestEntry;
  if (
    trustedManifestEntry.platform !== target.platform ||
    trustedManifestEntry.arch !== target.arch ||
    relativePath !== `ssh-owner/${targetDirectory}/${filename}` ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_BYTES
  ) {
    throw new StandaloneSshOwnerExecutableError("manifestMismatch");
  }
  if (!isAbsolute(distDirectory) || normalize(distDirectory) !== distDirectory) {
    throw new StandaloneSshOwnerExecutableError("unsafePath");
  }

  const path = join(distDirectory, "ssh-owner", targetDirectory, filename);
  const directoryPaths = [distDirectory, join(distDirectory, "ssh-owner"), dirname(path)];
  const checkPosixMode = process.platform !== "win32" && target.platform !== "win32";
  try {
    const directories = [];
    for (const directory of directoryPaths) {
      directories.push({ path: directory, stat: await canonicalDirectory(directory) });
    }

    const named = await lstat(path, { bigint: true });
    assertSafeFile(named, checkPosixMode);
    if ((await realpath(path)) !== path) {
      throw new StandaloneSshOwnerExecutableError("unsafePath");
    }

    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const before = await file.stat({ bigint: true });
      assertSafeFile(before, checkPosixMode);
      if (!sameFile(named, before)) throw new StandaloneSshOwnerExecutableError("unsafePath");
      if (before.size !== BigInt(sizeBytes)) {
        throw new StandaloneSshOwnerExecutableError("integrityMismatch");
      }
      if (!(await matchesSshOwnerExecutableTarget(file, target, sizeBytes))) {
        throw new StandaloneSshOwnerExecutableError("invalidTarget");
      }
      if (checkPosixMode) await access(path, constants.X_OK);

      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      while (offset <= sizeBytes) {
        const { bytesRead } = await file.read(
          chunk,
          0,
          Math.min(chunk.length, sizeBytes + 1 - offset),
          offset,
        );
        if (bytesRead === 0) break;
        hash.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (
        offset !== sizeBytes ||
        hash.digest("hex") !== sha256 ||
        !sameFile(before, await file.stat({ bigint: true }))
      ) {
        throw new StandaloneSshOwnerExecutableError("integrityMismatch");
      }
      for (const directory of directories) {
        if (!sameFile(directory.stat, await canonicalDirectory(directory.path))) {
          throw new StandaloneSshOwnerExecutableError("unsafePath");
        }
      }
      if (
        !sameFile(before, await lstat(path, { bigint: true })) ||
        (await realpath(path)) !== path
      ) {
        throw new StandaloneSshOwnerExecutableError("unsafePath");
      }
      return path;
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (cause instanceof StandaloneSshOwnerExecutableError) throw cause;
    const code = (cause as NodeJS.ErrnoException).code;
    throw new StandaloneSshOwnerExecutableError(
      code === "ENOENT" ? "missingAsset" : code === "ELOOP" ? "unsafePath" : "unreadableAsset",
      { cause },
    );
  }
}
