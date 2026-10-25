import { constants } from "node:fs";
import { open, lstat, statfs } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { V2RecoveryHost } from "./RebootRecovery.host.ts";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Interpret kernel boot facts, never uptime or a process/service restart timestamp. */
export function decodeV2LinuxRecoveryHost(
  machine: string,
  session: string,
  stat: string,
): V2RecoveryHost {
  const machineId = machine.trim(),
    bootSession = session.trim();
  const times = [...stat.matchAll(/^btime (\d+)$/gm)];
  const seconds = Number(times[0]?.[1]);
  if (
    !/^[a-f0-9]{32}$/.test(machineId) ||
    /^0+$/.test(machineId) ||
    !uuid.test(bootSession) ||
    bootSession === "00000000-0000-0000-0000-000000000000" ||
    times.length !== 1 ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0
  )
    throw new Error("V2 authoritative Linux host/boot identity unavailable.");
  return Object.freeze({
    host: createHash("sha256").update(`bigbud.recovery.host.linux.v1:${machineId}`).digest("hex"),
    bootSession,
    bootSeconds: seconds,
    bootMicroseconds: 0,
  });
}

async function readSystemFile(filename: string, bound: number, proc: boolean) {
  for (let current = path.dirname(filename); ; ) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022)
      throw new Error("V2 recovery system namespace is not trusted.");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (proc && (await statfs(filename)).type !== 0x9fa0)
    throw new Error("V2 recovery boot facts require kernel procfs.");
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== 0 || before.mode & 0o022 || before.size > bound)
      throw new Error("V2 recovery system file is not trusted.");
    // procfs reports zero st_size. Bound actual reads rather than trusting its size.
    const bytes = Buffer.alloc(bound + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await file.stat(),
      named = await lstat(filename);
    if (
      length > bound ||
      named.isSymbolicLink() ||
      [after, named].some(
        (info) =>
          info.dev !== before.dev ||
          info.ino !== before.ino ||
          info.uid !== 0 ||
          info.mode !== before.mode ||
          info.size !== before.size ||
          info.mtimeMs !== before.mtimeMs,
      )
    )
      throw new Error("V2 recovery system evidence changed during observation.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

/** Fixed root-owned machine-id and real procfs sources only; missing evidence fails closed. */
export async function readV2LinuxRecoveryHost(): Promise<V2RecoveryHost> {
  const [machine, session, stat] = await Promise.all([
    readSystemFile("/etc/machine-id", 128, false),
    readSystemFile("/proc/sys/kernel/random/boot_id", 128, true),
    readSystemFile("/proc/stat", 1048576, true),
  ]);
  return decodeV2LinuxRecoveryHost(machine, session, stat);
}
