import { open } from "node:fs/promises";

export const STATE_DIR_LOCK_FILENAME = "backend.lock";
export interface OwnershipControl {
  readonly version: 1;
  readonly port: number;
  readonly secret: string;
}
export interface StateDirLockRecord {
  readonly format: "bigbud.backend-lock.v1";
  readonly pid: number;
  readonly startedAt: string | null;
  readonly port: number;
  readonly hostname: string;
  readonly machineId?: string | null;
  readonly acquiredAt: string;
  readonly nonce: string;
  readonly control?: OwnershipControl;
}

/** Legacy acquisition parsing stays permissive; stopping requires stricter checks. */
export function parseStateDirLockRecord(raw: string): StateDirLockRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<StateDirLockRecord>;
    if (
      value === null ||
      value.format !== "bigbud.backend-lock.v1" ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) < 1 ||
      !(value.startedAt === null || typeof value.startedAt === "string") ||
      !Number.isSafeInteger(value.port) ||
      typeof value.hostname !== "string" ||
      !(
        value.machineId === undefined ||
        value.machineId === null ||
        typeof value.machineId === "string"
      ) ||
      typeof value.acquiredAt !== "string" ||
      typeof value.nonce !== "string"
    )
      return undefined;
    return value as StateDirLockRecord;
  } catch {
    return undefined;
  }
}

export function hasOwnershipControl(record: StateDirLockRecord): record is StateDirLockRecord & {
  control: OwnershipControl;
  machineId: string;
  startedAt: string;
} {
  const control = record.control;
  return (
    typeof record.machineId === "string" &&
    /^machine-v1:[a-f0-9]{64}$/.test(record.machineId) &&
    typeof record.startedAt === "string" &&
    record.startedAt.startsWith("start-v2:") &&
    /^[a-f0-9]{32}$/.test(record.nonce) &&
    control?.version === 1 &&
    Number.isInteger(control.port) &&
    control.port > 0 &&
    control.port <= 65535 &&
    typeof control.secret === "string" &&
    /^[a-f0-9]{64}$/.test(control.secret)
  );
}

/** Bounded file read; never follows a lock symlink and never removes a lock. */
export async function readOwnershipLock(filename: string): Promise<StateDirLockRecord | undefined> {
  const { constants } = await import("node:fs");
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("owner_unverified", { cause: error });
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 8192 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("owner_unverified");
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const record =
      bytesRead <= 8192
        ? parseStateDirLockRecord(buffer.subarray(0, bytesRead).toString("utf8"))
        : undefined;
    if (!record) throw new Error("owner_unverified");
    return record;
  } finally {
    await file.close();
  }
}
