import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import {
  assertUnixSocketPathFits,
  createPrivateSocketDirectory,
} from "@bigbud/shared/privateSocketPath";

import { resolveManagedPaths } from "./cuaDriver.paths";

export interface PrivateEndpointOptions {
  readonly platform?: NodeJS.Platform;
  /** Test seam for the per-user socket root's parent (default `/tmp`). */
  readonly tmpRoot?: string;
}

/**
 * Each supervised daemon owns one private endpoint and PID directory.
 *
 * The run directory is not under `baseDir`: `~/.bigbud/channels/<channel>/...`
 * plus a run suffix exceeds the Unix socket path limit (104 bytes on macOS).
 * It lives at `/tmp/bigbud-<uid>/cua-<hash(baseDir)>-<random>/`, so channels
 * stay apart, and is removed when the daemon stops.
 */
export function resolvePrivateEndpoint(
  baseDir: string,
  options: PrivateEndpointOptions = {},
): {
  readonly endpoint: string;
  readonly runDir: string;
  readonly pidFile: string;
} {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const suffix = Crypto.randomUUID();
    // Named pipes have no file; the PID file stays in a private dir under baseDir.
    const runDir = Path.join(resolveManagedPaths(baseDir).rootDir, "run", suffix);
    FS.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    FS.chmodSync(runDir, 0o700);
    return {
      endpoint: `\\\\.\\pipe\\bigbud-cua-${suffix}`,
      runDir,
      pidFile: Path.join(runDir, "cua.pid"),
    };
  }
  const runDir = createPrivateSocketDirectory({
    scopeKey: baseDir,
    prefix: "cua",
    ...(options.tmpRoot ? { tmpRoot: options.tmpRoot } : {}),
  });
  try {
    return {
      endpoint: assertUnixSocketPathFits(Path.join(runDir, "cua.sock"), platform),
      runDir,
      pidFile: Path.join(runDir, "cua.pid"),
    };
  } catch (error) {
    FS.rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}
