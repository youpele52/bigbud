import { execFileSync } from "node:child_process";

/**
 * Stable start-time token for a live process (`ps -o lstart=`), used to tell a recorded owner
 * from an unrelated process that later reused its PID. `undefined` when unobtainable (for
 * example on Windows, or when the process is gone); callers must then fail closed.
 */
export function processStartToken(pid: number): string | undefined {
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value ? value.replaceAll(/\s+/g, "_") : undefined;
  } catch {
    return undefined;
  }
}
