import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { hasLocalSupervisorServiceControls } from "./localSupervisorService.paths.ts";
import { assertPrivateOwnership } from "./privatePermission.ts";

function uid(): bigint {
  if (!process.getuid) throw new Error("Account-service files require Unix ownership.");
  return BigInt(process.getuid());
}
function canonicalShape(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || hasLocalSupervisorServiceControls(path))
    throw new Error("Service file paths must be absolute and canonical.");
}

export async function assertLocalSupervisorServiceDirectory(
  path: string,
  allowedModes: ReadonlyArray<number> = [0o700],
): Promise<void> {
  canonicalShape(path);
  if (
    allowedModes.length === 0 ||
    allowedModes.some((mode) => ![0o700, 0o750, 0o755].includes(mode))
  )
    throw new Error("Service directory modes must remain non-writable to other users.");
  const stat = await fs.lstat(path, { bigint: true });
  const message = "Service directory must be canonical, owned and safely permissioned.";
  if (!stat.isDirectory()) throw new Error(message);
  uid();
  assertPrivateOwnership(stat, { kind: "directory", path, allowedModes, message });
  if ((await fs.realpath(path)) !== path) throw new Error(message);
}

/** Bounded immutable snapshot. Does not create, chmod, follow links or read credentials implicitly. */
export async function readLocalSupervisorServiceFile(
  path: string,
  maxBytes: number,
): Promise<string> {
  canonicalShape(path);
  uid();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
    throw new Error("Service file read exceeds the bounded policy.");
  if ((await fs.realpath(path)) !== path)
    throw new Error("Service file path must not contain links.");
  const file = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    const message = "Service file must be a bounded private owned single-link regular file.";
    if (!before.isFile()) throw new Error(message);
    assertPrivateOwnership(before, { kind: "file", path, allowedModes: [0o600], message });
    if (before.nlink !== 1n || before.size < 1n || before.size > BigInt(maxBytes))
      throw new Error(message);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const named = await fs.lstat(path, { bigint: true });
    if (
      BigInt(length) !== before.size ||
      before.size !== after.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.uid !== after.uid ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      !named.isFile() ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      named.uid !== after.uid ||
      named.mode !== after.mode ||
      named.nlink !== after.nlink ||
      named.size !== after.size ||
      named.mtimeNs !== after.mtimeNs ||
      named.ctimeNs !== after.ctimeNs
    )
      throw new Error("Service file changed while reading; preserve it for repair.");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    await file.close();
  }
}
