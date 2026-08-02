import * as ChildProcess from "node:child_process";

export function killBackendProcess(
  child: ChildProcess.ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      ChildProcess.spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return;
    } catch {
      // taskkill unavailable — fall through to direct kill.
    }
  }
  child.kill(signal);
}
