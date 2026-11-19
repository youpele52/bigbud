/**
 * Detached process launch for editors, terminals and the system file manager.
 *
 * Never uses a shell. On Windows, `.exe`/`.com` targets are spawned directly and Node quotes
 * each argument. `.cmd`/`.bat` launchers (e.g. `code.cmd`), which Node refuses to spawn without a
 * shell, run under `cmd.exe /d /s /c` with every metacharacter escaped (the cross-spawn /
 * https://qntm.org/cmd algorithm, re-implemented here to avoid a dependency). Arguments
 * containing `"`, CR, LF or NUL are refused on that path: Windows paths cannot contain them, and
 * a batch file re-parses its `%*` arguments, where an embedded quote could end the quoting.
 *
 * @module OpenLaunch
 */
import { spawn, type SpawnOptions } from "node:child_process";
import * as nodePath from "node:path";

import { OpenError } from "@bigbud/contracts";
import { Effect, Schema } from "effect";

import { resolveCommandPath } from "./commandPath";

export interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * Windows only: `args` are already quoted for the target and must reach it unchanged. Used for
   * `explorer.exe`, which does not follow the MSVCRT rules (it splits unquoted paths on commas).
   * Refused for `.cmd`/`.bat` launchers.
   */
  readonly windowsVerbatimArguments?: boolean;
}

export interface SpawnPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: SpawnOptions;
}

export type SpawnProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => Pick<ReturnType<typeof spawn>, "once" | "unref">;

export interface LaunchOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnProcess?: SpawnProcess;
}

export const isOpenError = Schema.is(OpenError);

const WINDOWS_DIRECT_EXECUTABLE_PATTERN = /\.(?:exe|com)$/i;
const WINDOWS_BATCH_PATTERN = /\.(?:cmd|bat)$/i;
const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;
const CMD_UNSAFE_ARGUMENT = /["\r\n]/;

/** Escapes cmd.exe metacharacters in the launcher path. */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARACTERS, "^$1");
}

/** Quotes one argument for the launched program, then escapes it for cmd.exe's own parse. */
export function escapeCmdArgument(arg: string): string {
  const quoted = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  return `"${quoted}"`.replace(CMD_META_CHARACTERS, "^$1");
}

/** `%SystemRoot%\System32\cmd.exe`, then an absolute `ComSpec`, never a relative PATH alias. */
export function resolveWindowsCmdPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (systemRoot && nodePath.win32.isAbsolute(systemRoot)) {
    return nodePath.win32.join(systemRoot, "System32", "cmd.exe");
  }
  const comSpec = env.ComSpec ?? env.COMSPEC;
  return comSpec && nodePath.win32.isAbsolute(comSpec) ? comSpec : "cmd.exe";
}

const BASE_SPAWN_OPTIONS = { detached: true, stdio: "ignore", shell: false } as const;

/**
 * How to spawn `launch` without a shell, or an `OpenError` when the command is missing or the
 * arguments cannot be passed safely.
 */
export function resolveSpawnPlan(
  launch: EditorLaunch,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SpawnPlan | OpenError {
  const resolved = resolveCommandPath(launch.command, { platform, env });
  if (resolved === null) {
    return new OpenError({ message: `Editor command not found: ${launch.command}` });
  }
  if (platform !== "win32") {
    return { command: resolved, args: [...launch.args], options: { ...BASE_SPAWN_OPTIONS } };
  }

  if (WINDOWS_DIRECT_EXECUTABLE_PATTERN.test(resolved)) {
    return {
      command: resolved,
      args: [...launch.args],
      options: {
        ...BASE_SPAWN_OPTIONS,
        windowsVerbatimArguments: launch.windowsVerbatimArguments === true,
      },
    };
  }
  if (!WINDOWS_BATCH_PATTERN.test(resolved) || launch.windowsVerbatimArguments === true) {
    return new OpenError({ message: `Unsupported launcher: ${resolved}` });
  }
  if (launch.args.some((arg) => CMD_UNSAFE_ARGUMENT.test(arg) || arg.includes("\0"))) {
    return new OpenError({ message: "Path contains characters that cannot be passed safely." });
  }

  const commandLine = [
    escapeCmdCommand(nodePath.win32.normalize(resolved)),
    ...launch.args.map(escapeCmdArgument),
  ].join(" ");
  return {
    command: resolveWindowsCmdPath(env),
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    options: { ...BASE_SPAWN_OPTIONS, windowsVerbatimArguments: true },
  };
}

export const launchDetached = Effect.fn("launchDetached")(function* (
  launch: EditorLaunch,
  options: LaunchOptions = {},
) {
  const plan = resolveSpawnPlan(launch, options.platform, options.env);
  if (isOpenError(plan)) return yield* plan;
  const spawnProcess: SpawnProcess = options.spawnProcess ?? spawn;

  yield* Effect.callback<void, OpenError>((resume) => {
    let child;
    try {
      child = spawnProcess(plan.command, plan.args, plan.options);
    } catch (error) {
      return resume(
        Effect.fail(new OpenError({ message: "failed to spawn detached process", cause: error })),
      );
    }

    const handleSpawn = () => {
      child.unref();
      resume(Effect.void);
    };

    child.once("spawn", handleSpawn);
    child.once("error", (cause) =>
      resume(Effect.fail(new OpenError({ message: "failed to spawn detached process", cause }))),
    );
  });
});
