import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { version } from "../../package.json" with { type: "json" };

import {
  installCommandLineLauncher,
  resolveCommandLineLauncherTarget,
  type CommandLineLauncherResult,
} from "@bigbud/shared/commandLineLauncher";
import { resolveDesktopReleaseIdentity } from "@bigbud/shared/desktopReleaseIdentity";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

/**
 * The bundled server entry. Packaged builds run `dist/bin.mjs`, and every chunk sits beside it;
 * argv[1] is not reliable because the AppImage launcher runs a bootstrap file instead.
 */
function bundledServerEntry(): string {
  const beside = join(dirname(fileURLToPath(import.meta.url)), "bin.mjs");
  return existsSync(beside) ? beside : resolve(process.argv[1] ?? "");
}

export function describeCommandLineLauncherResult(result: CommandLineLauncherResult): string {
  switch (result.status) {
    case "installed":
    case "updated":
      return [`bigbud command ${result.status} at ${result.launcherPath}.`, result.pathHint]
        .filter(Boolean)
        .join("\n");
    case "existing-command":
      return `Another bigbud command already exists at ${result.existingPath}; it was left unchanged.`;
    case "unsupported":
      return `The bigbud command was not installed: ${result.reason}`;
  }
}

/**
 * `bigbud command-line install`: place the D2 launcher for the app this CLI is bundled in. The
 * desktop install scripts call it right after installing the app; the Settings action shares the
 * same implementation.
 */
const installCommand = Command.make("install", {
  json: Flag.boolean("json").pipe(Flag.withDescription("Print JSON."), Flag.optional),
}).pipe(
  Command.withDescription("Put a `bigbud` command on PATH that runs this app's bundled CLI."),
  Command.withHandler((options) =>
    Effect.sync(() => {
      const result = installCommandLineLauncher({
        platform: process.platform,
        homeDir: homedir(),
        pathValue: process.env.PATH ?? process.env.Path ?? "",
        // The bundled CLI's own release channel names its launcher (`bigbud`, `bigbud-beta`, ...).
        commandName: resolveDesktopReleaseIdentity(version).executableName,
        target: resolveCommandLineLauncherTarget({
          platform: process.platform,
          runtime: process.execPath,
          serverEntry: bundledServerEntry(),
          environment: process.env,
        }),
      });
      const json = Option.getOrElse(options.json, () => false);
      process.stdout.write(
        json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${describeCommandLineLauncherResult(result)}\n`,
      );
      process.exitCode = result.status === "installed" || result.status === "updated" ? 0 : 1;
    }),
  ),
);

export const commandLineCommand = Command.make("command-line").pipe(
  Command.withDescription("Manage the `bigbud` command-line launcher."),
  Command.withSubcommands([installCommand]),
);
