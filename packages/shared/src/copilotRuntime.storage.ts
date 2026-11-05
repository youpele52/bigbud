import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import Path from "node:path";
import { createDevPortCoordinator } from "./DevPortCoordinator.ts";
import { readManagedCopilotVersion } from "./copilotRuntime.paths.ts";

export async function runtimeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Refusing symlinked Copilot storage.");
}

/** Call only under the long installation lock; unrecognized user data is never removed. */
export async function recoverCopilotStaging(directory: string): Promise<void> {
  await runtimeDirectory(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!/^[1-9]\d*-[a-f0-9-]{36}$/.test(entry.name) || !entry.isDirectory())
      throw new Error("Unrecognized Copilot staging entry; refusing automatic cleanup.");
    await rm(Path.join(directory, entry.name), { recursive: true });
  }
}

/** A short transaction lock, independent of the longer download/install lock. */
export async function withCopilotRuntimeLock<T>(
  root: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
  install = false,
): Promise<T> {
  await runtimeDirectory(root);
  const coordination = Path.join(root, install ? ".install-coordination" : ".coordination");
  await runtimeDirectory(coordination);
  const coordinator = await createDevPortCoordinator(root, coordination);
  return coordinator.withLock(action, signal);
}

/** Private fixed-name state is atomically replaced; no symlink reads or partial JSON. */
export async function writeRuntimeState(root: string, name: string, value: unknown): Promise<void> {
  await writeRuntimeText(root, name, JSON.stringify(value));
}

async function writeRuntimeText(root: string, name: string, value: string): Promise<void> {
  const temporary = Path.join(root, `.state-${process.pid}-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, Path.join(root, name));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function syncRuntimeDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const file = await open(directory, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Atomic, immutable version publication shared by downloads and trusted bundle preservation. */
export async function publishCopilotRuntime(root: string, relative: string, staged?: string) {
  if (!/^\d+\.\d+\.\d+\/(darwin|linux|linuxmusl|win32)-(arm64|x64)$/.test(relative))
    throw new Error("Invalid Copilot publication target.");
  return withCopilotRuntimeLock(root, async () => {
    const version = relative.split("/")[0]!;
    if (staged) {
      await syncRuntimeDirectory(Path.join(staged, "package"));
      await syncRuntimeDirectory(staged);
      await runtimeDirectory(Path.join(root, version));
      try {
        await lstat(Path.join(root, relative));
        throw new Error("Refusing to overwrite an existing Copilot runtime version.");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await rename(staged, Path.join(root, relative));
      await syncRuntimeDirectory(Path.join(root, version));
    }
    const installed = readManagedCopilotVersion(root, relative);
    if (!installed) throw new Error("Published Copilot runtime failed installation validation.");
    await writeRuntimeText(root, "current", `${relative}\n`);
    await syncRuntimeDirectory(root);
    return installed;
  });
}

export async function readRuntimeState(root: string, name: string): Promise<unknown> {
  const filename = Path.join(root, name);
  try {
    if (!(await lstat(filename)).isFile()) throw new Error("Unsafe Copilot state file.");
    const file = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 16_384) throw new Error("Unsafe Copilot state file.");
      const bytes = Buffer.alloc(16_385);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 16_384) throw new Error("Oversized Copilot state file.");
      return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function runtimeOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

/** Leases cover all Copilot clients, including probes and native title generation. */
export async function acquireCopilotLease(root: string): Promise<() => Promise<void>> {
  return withCopilotRuntimeLock(root, async () => {
    const directory = Path.join(root, ".leases");
    await runtimeDirectory(directory);
    const filename = Path.join(directory, `${process.pid}-${randomUUID()}`);
    const file = await open(filename, "wx", 0o600);
    await file.close();
    return () => rm(filename, { force: true });
  });
}

/** Call under the transaction lock. Unknown ownership blocks deletion, never expires by age. */
export async function activeCopilotLeases(root: string): Promise<number> {
  const directory = Path.join(root, ".leases");
  await runtimeDirectory(directory);
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const match = /^([1-9]\d*)-[a-f0-9-]{36}$/.exec(entry.name);
    const pid = Number(match?.[1]);
    if (!match || !entry.isFile() || !Number.isSafeInteger(pid) || pid > 2147483647)
      throw new Error("Unknown Copilot lease ownership; stop sessions before removal.");
    if (runtimeOwnerAlive(pid)) count++;
    else await rm(Path.join(directory, entry.name));
  }
  return count;
}
