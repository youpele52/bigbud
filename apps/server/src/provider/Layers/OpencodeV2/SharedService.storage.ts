import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { discoverV2SharedService } from "./SharedService.discovery.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";

const executeFile = promisify(execFile);
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
  if (process.platform !== "darwin")
    throw new V2SharedServiceError(
      "compatibility",
      "Shared OpenCode v2 database identity is currently qualified on macOS only. Use explicit isolated mode on this platform; no profile was changed.",
      before.version,
    );
  try {
    const pid = String(before.registration.pid);
    const { stdout } = await executeFile("/usr/sbin/lsof", ["-a", "-p", pid, "-Fn"], {
      timeout: 5000,
      maxBuffer: 512 * 1024,
    });
    const files = stdout
      .split("\n")
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1));
    const candidates = [
      ...new Set(
        files.filter(
          (file) =>
            /\.(db|sqlite|sqlite3)$/.test(file) &&
            (files.includes(`${file}-wal`) || files.includes(`${file}-shm`)),
        ),
      ),
    ];
    if (candidates.length !== 1) throw new Error("Ambiguous native SQLite handle.");
    const databasePath = await realpath(candidates[0]!);
    const metadata = await stat(databasePath);
    if (!metadata.isFile() || metadata.uid !== process.getuid?.())
      throw new Error("Native storage owner mismatch.");
    const { stdout: command } = await executeFile("/bin/ps", ["-p", pid, "-o", "comm="], {
      timeout: 5000,
      maxBuffer: 4096,
    });
    const binaryPath = command.trim();
    if (!binaryPath.startsWith("/") || !/opencode(?:$|\s)/.test(binaryPath))
      throw new Error("Native executable identity unavailable.");
    const after = await discoverV2SharedService({ file: registrationFile });
    if (before.generation !== after.generation) throw new Error("Native generation changed.");
    return {
      registrationFile,
      databasePath,
      binaryPath,
      generation: before.generation,
      storageIdentity: createHash("sha256")
        .update(
          JSON.stringify(["opencodeV2-shared-local", databasePath, metadata.dev, metadata.ino]),
        )
        .digest("hex"),
    };
  } catch {
    throw new V2SharedServiceError(
      "generation",
      "OpenCode v2 shared database identity could not be verified from the registered process's open SQLite handles. Check the native service or use explicit isolated mode; no history was rebound.",
      before.version,
    );
  }
}
