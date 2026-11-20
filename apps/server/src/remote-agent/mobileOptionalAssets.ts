import {
  cleanupOwnedMobileAssetTree,
  mobileAssetIdentity as identity,
  mobileAssetFileFingerprint as fileFingerprint,
  type MobileAssetOwnedFile,
} from "./mobileOptionalAssets.cleanup.ts";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { MobileOptionalArtifactCompatibility } from "@bigbud/contracts/server/mobileOptionalArtifact";
import {
  assertMobileOptionalArtifactCompatibility,
  parseMobileOptionalArtifact,
  verifyMobileOptionalArtifactBytes,
  verifyMobileOptionalArtifactSignature,
  type MobileOptionalArtifactHost,
} from "@bigbud/shared/mobileOptionalArtifact";
import { extractMobileAssetGzip } from "./mobileOptionalAssets.gzip.ts";
import { MobileAssetTarParser } from "./mobileOptionalAssets.tar.ts";

export interface MobileOptionalAssetsExtraction {
  readonly mobileConsent: boolean;
  readonly artifact: unknown;
  readonly bytes: Uint8Array;
  readonly trustedKeys: Readonly<Record<string, string>>;
  readonly host: MobileOptionalArtifactHost;
  readonly release: Pick<
    MobileOptionalArtifactCompatibility,
    "gatewayVersion" | "mobileAssetVersion"
  >;
  readonly destination: string;
  readonly signal?: AbortSignal;
}

function assertPrivateDirectory(info: Stats): void {
  if (
    !info.isDirectory() ||
    process.getuid === undefined ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Mobile extraction requires an owned private directory.");
}

/** Fresh private staging only. Returned path/data never authorizes CAS activation. */
export async function extractMobileOptionalAssets(
  input: MobileOptionalAssetsExtraction,
): Promise<string | null> {
  if (input.mobileConsent !== true) return null;
  input.signal?.throwIfAborted();
  const artifact = parseMobileOptionalArtifact(input.artifact);
  if (artifact.kind !== "mobile-assets") throw new Error("Expected signed mobile assets artifact.");
  verifyMobileOptionalArtifactSignature(artifact, input.trustedKeys);
  assertMobileOptionalArtifactCompatibility(artifact, input.host, input.release);
  // Snapshot before any await/IO: mutable prepared buffers carry no admission authority.
  const supplied = input.bytes;
  if (!(supplied instanceof Uint8Array) || supplied.byteLength !== artifact.sizeBytes) {
    throw new Error("Mobile assets supplied byte size does not match the signed manifest.");
  }
  const bytes = Buffer.from(supplied);
  verifyMobileOptionalArtifactBytes(artifact, bytes);
  input.signal?.throwIfAborted();
  const requested = resolve(input.destination);
  const leaf = basename(requested);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(leaf))
    throw new Error("Unsafe mobile staging directory name.");
  const parent = await realpath(dirname(requested));
  const parentHandle = await open(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const destination = join(parent, leaf);
  const directoryIdentities = new Map<string, string>();
  const ownedFiles = new Map<string, MobileAssetOwnedFile>();
  try {
    const parentInfo = await parentHandle.stat();
    assertPrivateDirectory(parentInfo);
    const check = async (member?: string) => {
      input.signal?.throwIfAborted();
      const currentParent = await lstat(parent);
      assertPrivateDirectory(currentParent);
      if (identity(currentParent) !== identity(parentInfo))
        throw new Error("Mobile staging parent changed.");
      const selected = member === undefined ? [...directoryIdentities.keys()] : [destination];
      if (member !== undefined) {
        const parts = member.split("/");
        parts.pop();
        for (let depth = 1; depth <= parts.length; depth += 1)
          selected.push(join(destination, ...parts.slice(0, depth)));
      }
      for (const path of selected) {
        const expected = directoryIdentities.get(path);
        const info = await lstat(path);
        assertPrivateDirectory(info);
        if (identity(info) !== expected) throw new Error("Mobile staging directory changed.");
      }
    };
    await check();
    await mkdir(destination, { mode: 0o700 }); // Exclusive; no existing tree is modified.
    directoryIdentities.set(destination, identity(await lstat(destination)));
    const parser = new MobileAssetTarParser({
      completedFile: (path, info) => {
        const record = ownedFiles.get(join(destination, path));
        if (!record || record.identity !== identity(info))
          throw new Error("Completed asset ownership changed.");
        record.completedFingerprint = fileFingerprint(info);
      },
      directory: async (path) => {
        await check(path);
        const target = join(destination, path);
        await mkdir(target, { mode: 0o700 });
        directoryIdentities.set(target, identity(await lstat(target)));
      },
      file: async (path) => {
        await check(path);
        const target = join(destination, path);
        const file = await open(
          target,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        try {
          ownedFiles.set(target, { identity: identity(await file.stat()) });
        } catch (cause) {
          await file.close();
          throw cause;
        }
        return file;
      },
    });
    await extractMobileAssetGzip(bytes, parser, input.signal);
    await check();
    for (const [path, record] of ownedFiles) {
      if (
        !record.completedFingerprint ||
        fileFingerprint(await lstat(path)) !== record.completedFingerprint
      )
        throw new Error("Completed mobile asset changed during extraction.");
    }
    await check();
    return destination;
  } catch (error) {
    cleanupOwnedMobileAssetTree(directoryIdentities, ownedFiles);
    throw error;
  } finally {
    await parentHandle.close();
  }
}
