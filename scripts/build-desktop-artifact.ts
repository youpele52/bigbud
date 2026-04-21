#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { buildDesktopArtifact } from "./lib/desktop-artifact/build.ts";
import {
  BuildArch,
  BuildPlatform,
  desktopArtifactCliRuntimeLayer,
  resolveBuildOptions,
} from "./lib/desktop-artifact/shared.ts";

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription(
      "Build platform (env: BIGBUD_DESKTOP_PLATFORM, legacy: T3CODE_DESKTOP_PLATFORM).",
    ),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: BIGBUD_DESKTOP_TARGET, legacy: T3CODE_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription(
      "Build arch, for example arm64/x64/universal (env: BIGBUD_DESKTOP_ARCH, legacy: T3CODE_DESKTOP_ARCH).",
    ),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription(
      "Artifact version metadata (env: BIGBUD_DESKTOP_VERSION, legacy: T3CODE_DESKTOP_VERSION).",
    ),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription(
      "Output directory for artifacts (env: BIGBUD_DESKTOP_OUTPUT_DIR, legacy: T3CODE_DESKTOP_OUTPUT_DIR).",
    ),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `bun run build:desktop` and use existing dist artifacts (env: BIGBUD_DESKTOP_SKIP_BUILD, legacy: T3CODE_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription(
      "Keep temporary staging files (env: BIGBUD_DESKTOP_KEEP_STAGE, legacy: T3CODE_DESKTOP_KEEP_STAGE).",
    ),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses Azure Trusted Signing (env: BIGBUD_DESKTOP_SIGNED, legacy: T3CODE_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription(
      "Stream subprocess stdout (env: BIGBUD_DESKTOP_VERBOSE, legacy: T3CODE_DESKTOP_VERBOSE).",
    ),
    Flag.optional,
  ),
  mockUpdates: Flag.boolean("mock-updates").pipe(
    Flag.withDescription(
      "Enable mock updates (env: BIGBUD_DESKTOP_MOCK_UPDATES, legacy: T3CODE_DESKTOP_MOCK_UPDATES).",
    ),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.string("mock-update-server-port").pipe(
    Flag.withDescription(
      "Mock update server port (env: BIGBUD_DESKTOP_MOCK_UPDATE_SERVER_PORT, legacy: T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for bigbud."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(desktopArtifactCliRuntimeLayer),
  NodeRuntime.runMain,
);
