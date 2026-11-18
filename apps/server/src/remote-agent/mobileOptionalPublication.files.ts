import type { MobileGatewayControllerHost } from "./mobileGatewayLifecycle.schema.ts";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";
import { createHash } from "node:crypto";
import type {
  MobileRegistryOwner,
  MobileRegistryController,
} from "./remoteAgentInstall.mobile.schema.ts";
import type {
  MobilePublicationIntent,
  MobilePublicationReceipt,
} from "./mobileOptionalPublication.schema.ts";
import { assertLocalSupervisorServiceDirectory } from "../remote-backend/localSupervisorService.files.ts";

export const MOBILE_COMPONENT_NAMESPACE = "components-v1";
export const GATEWAY_COMPONENT_FILE = "gateway";
export const ASSETS_COMPONENT_FILE = "assets.tar.gz";
export class MobilePublicationRepairRequired extends Error {
  readonly _tag = "MobilePublicationRepairRequired";
}
export const directoryIdentity = (info: BigIntStats) => ({
  dev: info.dev.toString(),
  ino: info.ino.toString(),
});
export const fileIdentity = (info: BigIntStats) => ({
  ...directoryIdentity(info),
  mtimeNs: info.mtimeNs.toString(),
  ctimeNs: info.ctimeNs.toString(),
});
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function mobilePublicationDirectoryKey(
  owner: MobileRegistryOwner,
  stage: {
    readonly id: string;
    readonly releaseId: string;
    readonly consentRevision: number;
    readonly controller: MobileRegistryController;
    readonly controllerHost?: MobileGatewayControllerHost | undefined;
  },
): string {
  return createHash("sha256")
    .update("bigbud.mobile-component-directory.v1\0")
    .update(
      JSON.stringify([
        owner.authority.authorityId,
        owner.authority.keyFingerprint,
        owner.authority.keyEpoch,
        owner.installationFingerprint,
        stage.id,
        stage.releaseId,
        stage.consentRevision,
        stage.controller.id,
        stage.controller.pid,
        stage.controller.startedAt,
        ...(stage.controllerHost
          ? [stage.controllerHost.hostname, stage.controllerHost.machineId]
          : []),
      ]),
    )
    .digest("hex");
}

export async function privateDirectory(path: string, create = false) {
  if (create)
    try {
      await fs.mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  await assertLocalSupervisorServiceDirectory(path);
  return fs.lstat(path, { bigint: true });
}
export async function syncDirectory(path: string): Promise<void> {
  const directory = await fs.open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function assertPublicationDirectories(root: string, intent: MobilePublicationIntent) {
  const namespace = join(root, MOBILE_COMPONENT_NAMESPACE);
  const directory = join(namespace, intent.key);
  for (const [path, expected] of [
    [root, intent.root],
    [namespace, intent.namespace],
    [directory, intent.directory],
  ] as const) {
    if (!equal(directoryIdentity(await privateDirectory(path)), expected))
      throw new Error("Mobile publication root or directory was substituted.");
  }
  return directory;
}

export async function readComponent(
  path: string,
  artifact: MobileOptionalArtifact,
  mode: number,
  retainBytes = false,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if ((await fs.realpath(path)) !== path) throw new Error("Mobile component path contains a link.");
  const file = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      before.nlink !== 1n ||
      (before.mode & 0o7777n) !== BigInt(mode) ||
      before.size !== BigInt(artifact.sizeBytes)
    ) {
      throw new Error("Mobile component requires exact private owned regular file bytes.");
    }
    const bytes = retainBytes ? Buffer.alloc(artifact.sizeBytes) : undefined;
    const chunk = bytes ?? Buffer.alloc(64 * 1024);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < artifact.sizeBytes) {
      signal?.throwIfAborted();
      const target = bytes ? offset : 0;
      const read = await file.read(
        chunk,
        target,
        Math.min(64 * 1024, artifact.sizeBytes - offset),
        offset,
      );
      signal?.throwIfAborted();
      if (!read.bytesRead) throw new Error("Mobile component was truncated.");
      hash.update(chunk.subarray(target, target + read.bytesRead));
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if (
      (await file.read(extra, 0, 1, offset)).bytesRead ||
      !equal(fileIdentity(before), fileIdentity(await file.stat({ bigint: true }))) ||
      !equal(fileIdentity(before), fileIdentity(await fs.lstat(path, { bigint: true })))
    ) {
      throw new Error("Mobile component changed while reading.");
    }
    if (hash.digest("hex") !== artifact.sha256)
      throw new Error("Mobile component SHA-256 verification failed.");
    signal?.throwIfAborted();
    return { bytes, identity: fileIdentity(before) };
  } finally {
    await file.close();
  }
}

/** Existing bytes are read-only reconciliation; a partial or foreign member is never overwritten. */
export async function writeComponent(
  path: string,
  artifact: MobileOptionalArtifact,
  bytes: Buffer,
  mode: number,
  guard: () => Promise<void>,
  signal?: AbortSignal,
) {
  await guard();
  let file;
  try {
    file = await fs.open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      mode,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readComponent(path, artifact, mode, false, signal);
  }
  try {
    for (let offset = 0; offset < bytes.length; ) {
      await guard();
      const result = await file.write(
        bytes,
        offset,
        Math.min(64 * 1024, bytes.length - offset),
        offset,
      );
      if (!result.bytesWritten) throw new Error("Mobile component write made no progress.");
      offset += result.bytesWritten;
    }
    await file.sync();
  } finally {
    await file.close();
  }
  await guard();
  return readComponent(path, artifact, mode, false, signal);
}

export async function inspectPublishedPair(
  root: string,
  intent: MobilePublicationIntent,
  gateway: MobileOptionalArtifact,
  assets: MobileOptionalArtifact,
  retainArchive = false,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const directory = await assertPublicationDirectories(root, intent);
  const names: string[] = [];
  const stream = await fs.opendir(directory);
  for await (const entry of stream) {
    names.push(entry.name);
    if (names.length > 2) throw new Error("Unknown mobile publication members must be preserved.");
  }
  if (
    names.length !== 2 ||
    !names.includes(GATEWAY_COMPONENT_FILE) ||
    !names.includes(ASSETS_COMPONENT_FILE)
  )
    throw new Error("Incomplete mobile publication.");
  const binary = await readComponent(
    join(directory, GATEWAY_COMPONENT_FILE),
    gateway,
    0o700,
    false,
    signal,
  );
  const archive = await readComponent(
    join(directory, ASSETS_COMPONENT_FILE),
    assets,
    0o600,
    retainArchive,
    signal,
  );
  if (
    !equal(
      binary.identity,
      fileIdentity(await fs.lstat(join(directory, GATEWAY_COMPONENT_FILE), { bigint: true })),
    )
  )
    throw new Error("Earlier mobile component changed.");
  const info = await privateDirectory(directory);
  const receipt: MobilePublicationReceipt = {
    directoryMtimeNs: info.mtimeNs.toString(),
    directoryCtimeNs: info.ctimeNs.toString(),
    gateway: binary.identity,
    assets: archive.identity,
  };
  await assertPublicationDirectories(root, intent);
  if (
    !equal(
      binary.identity,
      fileIdentity(await fs.lstat(join(directory, GATEWAY_COMPONENT_FILE), { bigint: true })),
    ) ||
    !equal(
      archive.identity,
      fileIdentity(await fs.lstat(join(directory, ASSETS_COMPONENT_FILE), { bigint: true })),
    )
  ) {
    throw new Error("Final mobile component path changed.");
  }
  if (
    !equal(
      { mtime: receipt.directoryMtimeNs, ctime: receipt.directoryCtimeNs },
      {
        mtime: (await privateDirectory(directory)).mtimeNs.toString(),
        ctime: (await privateDirectory(directory)).ctimeNs.toString(),
      },
    )
  ) {
    throw new Error("Mobile publication directory changed during final verification.");
  }
  await assertPublicationDirectories(root, intent);
  signal?.throwIfAborted();
  return {
    receipt,
    gatewayBytes: binary.bytes,
    assetsBytes: archive.bytes,
    gatewayPath: join(directory, GATEWAY_COMPONENT_FILE),
    archivePath: join(directory, ASSETS_COMPONENT_FILE),
  };
}
