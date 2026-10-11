import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectV2LinuxProcess, type V2LinuxFileIdentity } from "./SharedService.storage.linux.ts";

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
      openedFiles: undefined as Map<string, V2LinuxFileIdentity> | undefined,
      files: stdout
        .split("\n")
        .filter((line) => line.startsWith("n"))
        .map((line) => line.slice(1)),
    };
  }
  if (process.platform !== "linux") throw new Error("Unsupported native metadata platform.");
  return inspectV2LinuxProcess(pid, signal);
}
