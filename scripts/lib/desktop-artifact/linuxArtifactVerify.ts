import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { BuildScriptError, commandOutputOptions, runCommand } from "./shared.ts";
import { assertLinuxElectronRuntimeFiles } from "./linuxRuntimeFiles.ts";

/**
 * Find the Linux unpacked app directory inside the electron-builder output.
 * electron-builder names it something like "linux-unpacked" under the dist dir.
 */
export const findLinuxUnpackedApp = Effect.fn("findLinuxUnpackedApp")(function* (
  stageDistDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const entries = yield* fs.readDirectory(stageDistDir);
  for (const entry of entries) {
    if (entry.startsWith("linux-")) {
      const candidate = path.join(stageDistDir, entry);
      const stat = yield* fs.stat(candidate).pipe(Effect.catch(() => Effect.succeed(null)));
      if (stat && stat.type === "Directory") {
        return candidate;
      }
    }
  }

  return yield* new BuildScriptError({
    message: `No linux-unpacked app found in ${stageDistDir}`,
  });
});

/**
 * Find the built AppImage artifact in the output directory.
 */
export const findAppImageArtifact = Effect.fn("findAppImageArtifact")(function* (
  outputDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const entries = yield* fs.readDirectory(outputDir);
  for (const entry of entries) {
    if (entry.endsWith(".AppImage")) {
      return path.join(outputDir, entry);
    }
  }

  return yield* new BuildScriptError({
    message: `No .AppImage artifact found in ${outputDir}`,
  });
});

/**
 * Extract an AppImage to a temp directory using --appimage-extract.
 */
export const extractAppImage = Effect.fn("extractAppImage")(function* (
  appImagePath: string,
  tempDir: string,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.log(`[desktop-artifact] Extracting AppImage: ${appImagePath}`);

  yield* runCommand(
    ChildProcess.make({
      cwd: tempDir,
      ...commandOutputOptions(verbose),
      shell: true,
    })`${appImagePath} --appimage-extract`,
  );

  const squashfsRoot = path.join(tempDir, "squashfs-root");
  if (!(yield* fs.exists(squashfsRoot))) {
    return yield* new BuildScriptError({
      message: `AppImage extraction did not produce squashfs-root in ${tempDir}`,
    });
  }

  return squashfsRoot;
});

/**
 * Verify required runtime files exist in an unpacked Linux app directory.
 */
export const verifyLinuxUnpackedArtifact = Effect.fn("verifyLinuxUnpackedArtifact")(function* (
  unpackedDir: string,
) {
  yield* Effect.log(`[desktop-artifact] Verifying unpacked Linux artifact: ${unpackedDir}`);
  yield* assertLinuxElectronRuntimeFiles(
    unpackedDir,
    "Linux unpacked artifact verification failed",
  );
  yield* Effect.log("[desktop-artifact] Unpacked Linux artifact verification passed.");
});

/**
 * Extract an AppImage and verify required runtime files inside it.
 */
export const verifyLinuxAppImageArtifact = Effect.fn("verifyLinuxAppImageArtifact")(function* (
  appImagePath: string,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;

  yield* Effect.log(`[desktop-artifact] Verifying AppImage artifact: ${appImagePath}`);

  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-appimage-verify-" });
  const extractedRoot = yield* extractAppImage(appImagePath, tempDir, verbose);

  yield* assertLinuxElectronRuntimeFiles(extractedRoot, "AppImage artifact verification failed");

  yield* Effect.log("[desktop-artifact] AppImage artifact verification passed.");
});

/**
 * Smoke test a Linux AppImage by running it headlessly with --version.
 * This ensures the AppImage can actually start on the host system.
 */
export const smokeTestLinuxAppImage = Effect.fn("smokeTestLinuxAppImage")(function* (
  appImagePath: string,
  verbose: boolean,
) {
  yield* Effect.log(`[desktop-artifact] Smoke testing AppImage: ${appImagePath}`);

  yield* runCommand(
    ChildProcess.make({
      ...commandOutputOptions(verbose),
      shell: true,
    })`${appImagePath} --appimage-extract-and-run --no-sandbox --version`,
  );

  yield* Effect.log("[desktop-artifact] AppImage smoke test passed.");
});
