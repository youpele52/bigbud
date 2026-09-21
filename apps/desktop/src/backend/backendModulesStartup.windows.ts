import * as FS from "node:fs";

export interface WindowsBackendModulesFileSystem {
  readonly symlinkSync: typeof FS.symlinkSync;
  readonly cpSync: typeof FS.cpSync;
}

export function ensureWindowsBackendModulesPath(
  modulesDir: string,
  nodeModulesPath: string,
  fileSystem: WindowsBackendModulesFileSystem = FS,
): void {
  try {
    fileSystem.symlinkSync(modulesDir, nodeModulesPath, "junction");
    console.log("[desktop] created node_modules junction (Windows)");
    return;
  } catch (junctionError) {
    console.warn("[desktop] junction creation failed, falling back to copy:", junctionError);
  }

  try {
    fileSystem.cpSync(modulesDir, nodeModulesPath, { recursive: true });
    console.log("[desktop] copied _modules → node_modules (Windows fallback)");
  } catch (copyError) {
    console.error("[desktop] failed to create node_modules (Windows):", copyError);
  }
}
