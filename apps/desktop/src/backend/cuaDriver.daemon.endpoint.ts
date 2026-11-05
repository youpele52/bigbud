import * as FS from "node:fs";
import * as Path from "node:path";

export type StaleDaemonEndpoint = "absent" | "removed" | "blocked";

/**
 * Before respawning on the same endpoint, remove a leftover socket file.
 * Driver 0.38 in embedded mode refuses to bind over an existing path and
 * leaves the owning host to prove and remove its stale socket; 0.9.1 removed
 * it itself, so this is a no-op for it. The endpoint is always inside
 * bigbud's private 0700 run directory (`runDir`), so bigbud owns it; an
 * endpoint outside that directory is never touched. Anything there that is
 * not a socket is never deleted and blocks the respawn. Windows named pipes
 * have no file.
 */
export function removeStaleDaemonSocket(
  endpoint: string,
  runDir: string,
  platform: NodeJS.Platform = process.platform,
): StaleDaemonEndpoint {
  if (platform === "win32") return "absent";
  if (Path.dirname(endpoint) !== runDir) return "blocked";
  let stat: FS.Stats;
  try {
    stat = FS.lstatSync(endpoint);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "blocked";
  }
  if (!stat.isSocket()) return "blocked";
  try {
    FS.unlinkSync(endpoint);
    return "removed";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "blocked";
  }
}
