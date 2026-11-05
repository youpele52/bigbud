import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import { resolveManagedPaths } from "./cuaDriver.paths";

/** Each supervised daemon owns one private endpoint and PID directory. */
export function resolvePrivateEndpoint(baseDir: string): {
  readonly endpoint: string;
  readonly runDir: string;
  readonly pidFile: string;
} {
  const suffix = Crypto.randomUUID();
  const runDir = Path.join(resolveManagedPaths(baseDir).rootDir, "run", suffix);
  FS.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  FS.chmodSync(runDir, 0o700);
  const pidFile = Path.join(runDir, "cua.pid");
  return {
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\bigbud-cua-${suffix}`
        : Path.join(runDir, "cua.sock"),
    runDir,
    pidFile,
  };
}
