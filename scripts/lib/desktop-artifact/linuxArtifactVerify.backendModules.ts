import { lstatSync, readlinkSync } from "node:fs";

import { Effect, Path } from "effect";

import { BuildScriptError } from "./shared.ts";

export const assertLinuxBackendModulesLink = Effect.fn("assertLinuxBackendModulesLink")(function* (
  appRoot: string,
  errorPrefix: string,
) {
  const path = yield* Path.Path;
  const nodeModulesPath = path.join(appRoot, "resources", "server", "node_modules");

  yield* Effect.try({
    try: () => {
      const stat = lstatSync(nodeModulesPath);
      if (!stat.isSymbolicLink()) {
        throw new Error(`${nodeModulesPath} is not a symlink.`);
      }

      const target = readlinkSync(nodeModulesPath);
      if (target !== "_modules") {
        throw new Error(`${nodeModulesPath} points to ${target}, expected _modules.`);
      }
    },
    catch: (cause) =>
      new BuildScriptError({
        message: `${errorPrefix}: backend node_modules symlink missing or invalid at ${nodeModulesPath}.`,
        cause,
      }),
  });
});
