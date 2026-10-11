import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readlink, stat } from "node:fs/promises";

const executeFile = promisify(execFile);

/** Inspect only the registered process; never execute its binary or read its environment/database. */
export async function inspectV2UnixProcess(pid: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (process.platform === "darwin") {
    const { stdout } = await executeFile("/usr/sbin/lsof", ["-a", "-p", String(pid), "-Fn"], {
      timeout: 5000,
      maxBuffer: 512 * 1024,
      ...(signal ? { signal } : {}),
    });
    const { stdout: command } = await executeFile("/bin/ps", ["-p", String(pid), "-o", "comm="], {
      timeout: 5000,
      maxBuffer: 4096,
      ...(signal ? { signal } : {}),
    });
    const binaryPath = command.trim();
    if (!binaryPath.startsWith("/")) throw new Error("Native executable identity unavailable.");
    return {
      binaryPath,
      files: stdout
        .split("\n")
        .filter((line) => line.startsWith("n"))
        .map((line) => line.slice(1)),
    };
  }
  if (process.platform !== "linux") throw new Error("Unsupported native metadata platform.");
  const root = `/proc/${pid}`;
  const owner = await stat(root);
  if (owner.uid !== process.getuid?.()) throw new Error("Native process owner mismatch.");
  const binaryPath = await readlink(`${root}/exe`);
  if (!binaryPath.startsWith("/") || binaryPath.endsWith(" (deleted)"))
    throw new Error("Native executable unavailable.");
  const entries = await readdir(`${root}/fd`);
  if (entries.length > 4096) throw new Error("Native handle inventory exceeds bound.");
  const files: string[] = [];
  // Sequential metadata reads bound concurrent work; only a vanished noncandidate FD is ignored.
  for (const entry of entries) {
    signal?.throwIfAborted();
    try {
      const name = await readlink(`${root}/fd/${entry}`);
      if (!name.startsWith("/") || name.endsWith(" (deleted)")) continue;
      const opened = await stat(`${root}/fd/${entry}`);
      const named = await stat(name);
      if (opened.isFile() && opened.dev === named.dev && opened.ino === named.ino) files.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  signal?.throwIfAborted();
  if (Buffer.byteLength(files.join("\n")) > 512 * 1024)
    throw new Error("Native metadata exceeds bound.");
  return { binaryPath, files };
}
