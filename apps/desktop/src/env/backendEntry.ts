import * as Path from "node:path";

/**
 * Bundled server CLI entry in packaged builds. It lives outside the asar archive (extraResources),
 * because neither child_process.spawn nor ELECTRON_RUN_AS_NODE can run scripts inside an asar.
 */
export function packagedBackendEntry(resourcesPath: string): string {
  return Path.join(resourcesPath, "server/dist/bin.mjs");
}
