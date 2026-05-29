import { Effect, FileSystem, Path } from "effect";
import { BuildScriptError } from "./shared.ts";

/**
 * Required Electron runtime files that must be present in a packaged Linux app.
 * These are core V8/ICU binaries that Electron needs to start.
 */
export const REQUIRED_LINUX_ELECTRON_RUNTIME_FILES = [
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "icudtl.dat",
] as const;

/**
 * Optional Electron runtime files that may be present depending on the Electron version.
 */
export const OPTIONAL_LINUX_ELECTRON_RUNTIME_FILES = [
  "browser_v8_context_snapshot.bin",
  "natives_blob.bin",
] as const;

/**
 * Check which required runtime files are missing from a directory.
 */
export const findMissingLinuxElectronRuntimeFiles = Effect.fn(
  "findMissingLinuxElectronRuntimeFiles",
)(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const missing: string[] = [];
  for (const fileName of REQUIRED_LINUX_ELECTRON_RUNTIME_FILES) {
    const filePath = path.join(rootDir, fileName);
    if (!(yield* fs.exists(filePath))) {
      missing.push(fileName);
    }
  }

  return missing;
});

/**
 * Assert that all required Linux Electron runtime files exist in the given directory.
 * Fails with a descriptive BuildScriptError if any are missing.
 */
export const assertLinuxElectronRuntimeFiles = Effect.fn("assertLinuxElectronRuntimeFiles")(
  function* (rootDir: string, context: string) {
    const missing = yield* findMissingLinuxElectronRuntimeFiles(rootDir);
    if (missing.length > 0) {
      return yield* new BuildScriptError({
        message: `${context}: Missing required Electron runtime files in ${rootDir}: ${missing.join(", ")}`,
      });
    }
  },
);
