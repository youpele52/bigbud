import { readdir, readlink, stat } from "node:fs/promises";

export interface V2LinuxFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}
export interface V2LinuxFileObservation {
  readonly name?: string;
  readonly identity?: V2LinuxFileIdentity;
  readonly issue?: "deleted" | "replaced" | "unavailable";
}

/** A partial inventory cannot establish that the surviving WAL pair is the service database. */
export function validateV2LinuxInventory(observations: readonly V2LinuxFileObservation[]) {
  if (observations.some((entry) => entry.issue !== undefined))
    throw new Error(
      "Native open-file inventory was invalidated; database identity is unconfirmed.",
    );
  return new Map(
    observations.flatMap((entry) =>
      entry.name && entry.identity ? [[entry.name, entry.identity] as const] : [],
    ),
  );
}

/** Preserve evidence of deleted/replaced/vanished FDs instead of filtering toward a false sole candidate. */
export async function inspectV2LinuxProcess(pid: number, signal?: AbortSignal) {
  const root = `/proc/${pid}`;
  const owner = await stat(root, { bigint: true });
  if (owner.uid !== BigInt(process.getuid!())) throw new Error("Native process owner mismatch.");
  const binaryPath = await readlink(`${root}/exe`);
  if (!binaryPath.startsWith("/") || binaryPath.endsWith(" (deleted)"))
    throw new Error("Native executable unavailable.");
  const entries = await readdir(`${root}/fd`);
  if (entries.length > 4096) throw new Error("Native handle inventory exceeds bound.");
  const observations: V2LinuxFileObservation[] = [];
  let bytes = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    let name: string | undefined;
    try {
      name = await readlink(`${root}/fd/${entry}`);
      if (!name.startsWith("/")) continue; // Positively identified socket/pipe/anonymous FD, not a disk pathname.
      bytes += Buffer.byteLength(name);
      if (bytes > 512 * 1024) throw new Error("Native metadata exceeds bound.");
      const opened = await stat(`${root}/fd/${entry}`, { bigint: true });
      if (!opened.isFile()) continue;
      if (name.endsWith(" (deleted)")) {
        observations.push({ name: name.slice(0, -10), identity: opened, issue: "deleted" });
        continue;
      }
      const named = await stat(name, { bigint: true });
      observations.push({
        name,
        identity: opened,
        ...(opened.dev !== named.dev || opened.ino !== named.ino
          ? { issue: "replaced" as const }
          : {}),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      observations.push({ ...(name ? { name } : {}), issue: "unavailable" });
    }
  }
  signal?.throwIfAborted();
  const openedFiles = validateV2LinuxInventory(observations);
  return { binaryPath, files: [...openedFiles.keys()], openedFiles };
}
