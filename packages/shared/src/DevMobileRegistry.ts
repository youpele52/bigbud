import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, opendir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

import { verifyMobileListenerUrl } from "@bigbud/shared/DevMobileRegistry.http";

export interface MobileDevRecord {
  readonly port: number;
  readonly nonce: string;
  readonly ownerPid: number;
}

export interface MobileDevRegistry {
  readonly directory: string;
}

function defaultRegistryRoot(): string {
  const { uid, username } = userInfo();
  const userKey = createHash("sha256")
    .update(JSON.stringify([uid, username]))
    .digest("hex")
    .slice(0, 32);
  return path.join(tmpdir(), `bigbud-mobile-dev-${userKey}`);
}

function ownerIsDead(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // PID reuse, permission failures, and uncertain owners must retain records.
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

export async function createMobileDevRegistry(
  repoRoot: string,
  instanceOffset = process.env.BIGBUD_DEV_INSTANCE_OFFSET ?? "0",
  registryRoot = defaultRegistryRoot(),
): Promise<MobileDevRegistry> {
  const offset = Number(instanceOffset);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("BIGBUD_DEV_INSTANCE_OFFSET must be a non-negative integer");
  }
  const scope = createHash("sha256")
    .update(JSON.stringify([await realpath(repoRoot), offset]))
    .digest("hex");
  return { directory: path.join(registryRoot, scope) };
}

export function createMobileDevRecord(port: number): MobileDevRecord {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Mobile development port must be between 1 and 65535");
  }
  return { port, nonce: randomUUID(), ownerPid: process.pid };
}

// Each listener owns only its nonce-named file, including during concurrent restarts.
export async function publishMobileDevRecord(
  registry: MobileDevRegistry,
  record: MobileDevRecord,
): Promise<() => Promise<void>> {
  // Called after the socket listens. Health is checked at discovery time so a
  // transiently busy listener can recover without restarting registration.
  await mkdir(registry.directory, { recursive: true, mode: 0o700 });
  const filename = path.join(registry.directory, `${record.nonce}.json`);
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
  return () => rm(filename, { force: true });
}

async function readRecord(directory: string, name: string): Promise<MobileDevRecord | null> {
  const file = await open(path.join(directory, name), "r").catch(() => null);
  if (!file) return null;
  try {
    // Bound both allocation and reads even if a record is malformed or replaced.
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024) return null;
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString());
    if (typeof value !== "object" || value === null) return null;
    if (!("port" in value) || !("nonce" in value) || !("ownerPid" in value)) return null;
    if (
      typeof value.port !== "number" ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535 ||
      typeof value.nonce !== "string" ||
      typeof value.ownerPid !== "number" ||
      !Number.isSafeInteger(value.ownerPid) ||
      value.ownerPid <= 0 ||
      !/^[a-f0-9-]{36}$/.test(value.nonce) ||
      name !== `${value.nonce}.json`
    )
      return null;
    return { port: value.port, nonce: value.nonce, ownerPid: value.ownerPid };
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

export async function discoverMobileDevUrl(registry: MobileDevRegistry): Promise<string | null> {
  const directory = await opendir(registry.directory).catch(() => null);
  if (!directory) return null;
  const records: MobileDevRecord[] = [];
  let scanned = 0;
  for await (const entry of directory) {
    // Confirmed-dead records are retired before enforcing the live-record cap.
    // A large crashed history is removed in bounded batches across requests.
    if (++scanned > 4096) return null;
    if (!entry.isFile()) continue;
    const temporary = /^[a-f0-9-]{36}\.json\.(\d+)\.tmp$/.exec(entry.name);
    if (temporary && ownerIsDead(Number(temporary[1]))) {
      await rm(path.join(registry.directory, entry.name), { force: true });
      continue;
    }
    if (entry.isFile() && /^[a-f0-9-]{36}\.json$/.test(entry.name)) {
      const record = await readRecord(registry.directory, entry.name);
      if (!record) continue;
      if (ownerIsDead(record.ownerPid)) {
        // Nonce files are immutable and unique; a newer listener owns a different
        // filename. Never remove records merely because health verification fails.
        await rm(path.join(registry.directory, entry.name), { force: true });
      } else {
        records.push(record);
        if (records.length > 256) return null;
      }
    }
  }
  records.sort((a, b) => a.port - b.port || a.nonce.localeCompare(b.nonce));
  // A fixed concurrency and absolute deadline also bound unresponsive listeners.
  const deadline = Date.now() + 1500;
  let next = 0;
  let lowestPort = Infinity;
  let selectedUrl: string | null = null;
  await Promise.all(
    Array.from({ length: Math.min(8, records.length) }, async () => {
      while (next < records.length && Date.now() < deadline) {
        const record = records[next++];
        if (!record || record.port > lowestPort) return;
        const url = await verifyMobileListenerUrl(record, Math.min(250, deadline - Date.now()));
        if (
          url &&
          (record.port < lowestPort ||
            selectedUrl === null ||
            (record.port === lowestPort && url < selectedUrl))
        ) {
          lowestPort = record.port;
          selectedUrl = url;
        }
      }
    }),
  );
  // Advertise the exact address we verified: localhost may prefer an unrelated
  // IPv6 listener even while this IPv4 listener remains healthy.
  return selectedUrl;
}
