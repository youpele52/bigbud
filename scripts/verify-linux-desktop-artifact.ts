#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";
import { resolve } from "node:path";

import {
  smokeTestLinuxAppImage,
  smokeTestLinuxAppImageBackendStartup,
  verifyLinuxAppImageArtifact,
} from "./lib/desktop-artifact/linuxArtifactVerify.ts";
import { desktopArtifactCliRuntimeLayer } from "./lib/desktop-artifact/shared.ts";

function parseArgs(argv: string[]): { appImagePath: string; verbose: boolean } {
  let appImagePath: string | null = null;
  let verbose = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (!arg?.startsWith("-") && appImagePath === null) {
      appImagePath = resolve(arg);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!appImagePath) {
    throw new Error(
      "Usage: node scripts/verify-linux-desktop-artifact.ts <path-to-AppImage> [--verbose]",
    );
  }

  return { appImagePath, verbose };
}

const { appImagePath, verbose } = parseArgs(process.argv.slice(2));

Effect.gen(function* () {
  yield* verifyLinuxAppImageArtifact(appImagePath, verbose);
  yield* smokeTestLinuxAppImage(appImagePath, verbose);
  yield* smokeTestLinuxAppImageBackendStartup(appImagePath, verbose);
}).pipe(Effect.scoped, Effect.provide(desktopArtifactCliRuntimeLayer), NodeRuntime.runMain);
