import { realpath, stat } from "node:fs/promises";
import { v2UnixStorageIdentity } from "./SharedService.storage.identity.ts";
import { discoverV2SharedService } from "./SharedService.discovery.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";
import { inspectV2UnixProcess } from "./SharedService.storage.unix.ts";
import { selectV2SharedDatabase } from "./SharedService.storage.files.ts";
import { inspectV2WindowsStorage } from "./SharedService.storage.windows.ts";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";

export interface V2SharedStorage {
  readonly registrationFile: string;
  readonly databasePath: string;
  readonly storageIdentity: string;
  readonly generation: string;
  readonly binaryPath: string;
}

/** Process-open-file metadata only: never read SQLite contents or guess the daemon's HOME. */
export async function resolveV2SharedStorage(registrationFile: string): Promise<V2SharedStorage> {
  const before = await discoverV2SharedService({ file: registrationFile });
  try {
    if (process.platform === "win32") {
      const storage = await inspectV2WindowsStorage(before.registration.pid);
      const after = await discoverV2SharedService({ file: registrationFile });
      if (before.generation !== after.generation) throw new Error("Native generation changed.");
      return { ...storage, registrationFile, generation: before.generation };
    }
    const inspect = () =>
      runWithAbortableDeadline({
        operation: "Native process metadata",
        timeoutMs: 5000,
        run: (signal) => inspectV2UnixProcess(before.registration.pid, signal),
      });
    const first = await inspect();
    const { files, binaryPath } = first;
    const selected = selectV2SharedDatabase(files);
    const databasePath = await realpath(selected);
    const inspectPath = () =>
      process.platform === "linux" ? stat(databasePath, { bigint: true }) : stat(databasePath);
    const metadata = await inspectPath();
    const uid = process.platform === "linux" ? BigInt(process.getuid!()) : process.getuid?.();
    if (!metadata.isFile() || metadata.uid !== uid)
      throw new Error("Native storage owner mismatch.");
    const second = await inspect();
    if (
      (await realpath(selectV2SharedDatabase(second.files))) !== databasePath ||
      second.binaryPath !== binaryPath
    )
      throw new Error("Native open file identity changed.");
    const retained = await inspectPath();
    if (retained.dev !== metadata.dev || retained.ino !== metadata.ino)
      throw new Error("Native storage changed.");
    if (process.platform === "linux") {
      for (const inventory of [first, second]) {
        const opened = inventory.openedFiles?.get(selected);
        if (opened?.dev !== metadata.dev || opened.ino !== metadata.ino)
          throw new Error("Native database pathname no longer identifies the opened file.");
      }
    }
    const after = await discoverV2SharedService({ file: registrationFile });
    if (before.generation !== after.generation) throw new Error("Native generation changed.");
    return {
      registrationFile,
      databasePath,
      binaryPath,
      generation: before.generation,
      storageIdentity: v2UnixStorageIdentity(
        process.platform as "darwin" | "linux",
        databasePath,
        metadata,
      ),
    };
  } catch {
    throw new V2SharedServiceError(
      "generation",
      "OpenCode v2 shared database identity could not be verified from the registered process's open SQLite handles. Check the native service or use explicit isolated mode; no history was rebound.",
      before.version,
    );
  }
}
