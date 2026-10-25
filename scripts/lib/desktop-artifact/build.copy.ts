import { cp } from "node:fs/promises";

import { Effect, FileSystem, Path } from "effect";

import { BuildScriptError } from "./shared.ts";

/** Keeps bundle-relative links relocatable after temporary packaging staging is removed. */
export const copyDesktopArtifacts = Effect.fn("copyDesktopArtifacts")(function* (
  stageDistDir: string,
  outputDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(outputDir, { recursive: true });
  const copiedArtifacts: Array<string> = [];

  for (const entry of entries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from);
    if (stat.type !== "File" && stat.type !== "Directory") continue;
    const to = path.join(outputDir, entry);
    yield* Effect.tryPromise({
      try: () => cp(from, to, { recursive: true, force: true, verbatimSymlinks: true }),
      catch: (cause) =>
        new BuildScriptError({
          message: `Failed to copy desktop artifact from ${from} to ${to}.`,
          cause,
        }),
    });
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new BuildScriptError({
      message: `Build completed but no files were produced in ${stageDistDir}`,
    });
  }
  return copiedArtifacts;
});
