import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";

import { assertPrivateDirectory, ensurePrivateDirectory } from "./localTerminalHost.fs.ts";
import type { LocalTerminalHostGenerationPaths } from "./localTerminalHost.paths.ts";

export const LOCAL_TERMINAL_HOST_MINIMAL_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** Build A X2 hosts advertise this; an older host must be treated as unsupported. */
export { TERMINAL_HOST_RETIREMENT_CAPABILITY } from "../remote-agent/remoteAgentProtocol.terminalHost.ts";
const SOCKET_WAIT_MS = 5_000;
const SOCKET_POLL_MS = 50;

export class LocalTerminalHostLaunchError extends Error {
  readonly _tag = "LocalTerminalHostLaunchError";
}

const DEBUG_TERMINAL_ENV = /^BIGBUD_DEBUG_TERMINAL_[A-Z0-9_]{1,48}$/;

/**
 * The host starts with a minimal explicit environment. The user's shell environment reaches
 * each PTY through its launch spec (S6), never through the long-lived host process.
 */
export function localTerminalHostEnvironment(
  environment: NodeJS.ProcessEnv,
  statePath: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"]) {
    const value = environment[key];
    if (value !== undefined && value !== "") result[key] = value;
  }
  for (const [key, value] of Object.entries(environment))
    if (key.startsWith("LC_") && value !== undefined && value !== "") result[key] = value;
  // Debug clocks and overrides (idle, pressure, self-exit) for real-process tests; release host
  // builds ignore them.
  for (const [key, value] of Object.entries(environment))
    if (DEBUG_TERMINAL_ENV.test(key) && value !== undefined && /^[\w.-]{1,32}$/.test(value))
      result[key] = value;
  result.HOME ??= homedir();
  result.PATH = LOCAL_TERMINAL_HOST_MINIMAL_PATH;
  result.BIGBUD_AGENT_STATE_DIR = statePath;
  // One malloc magazine keeps the host's peak RSS inside the 256 MiB budget on macOS (R7: peaks
  // 255–263 MiB → 245–252 MiB at 24 PTYs). PTYs get their environment from the launch spec, so
  // user shells never inherit this.
  if (platform === "darwin") result.MallocMaxMagazines = "1";
  return result;
}

export type LocalTerminalHostSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => Pick<ChildProcess, "pid" | "unref" | "once" | "exitCode" | "signalCode" | "kill">;

export interface LaunchLocalTerminalHostInput {
  readonly binaryPath: string;
  readonly generation: LocalTerminalHostGenerationPaths;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawn?: LocalTerminalHostSpawn;
  readonly socketWaitMs?: number;
  readonly pollMs?: number;
}

export interface LaunchedLocalTerminalHost {
  readonly pid: number;
}

/** Creates `state-<n>/` as a private directory under the already-private terminal-host root. */
export async function prepareLocalTerminalHostGeneration(
  root: string,
  generation: LocalTerminalHostGenerationPaths,
): Promise<void> {
  await ensurePrivateDirectory(root);
  try {
    await fs.mkdir(generation.statePath, { mode: 0o700 });
    await fs.chmod(generation.statePath, 0o700);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
  await assertPrivateDirectory(generation.statePath);
}

/**
 * The plan §7.3 item 7 command line. `--local-desktop-host` allows `local_launch` creates (the
 * login environment, S6) and makes the host lead its own session; `--exit-when-orphaned-and-empty`
 * lets it exit 60 s after its last PTY and owner are gone.
 */
export const LOCAL_TERMINAL_HOST_ARGS: ReadonlyArray<string> = [
  "--supervisor",
  "--local-desktop-host",
  "--exit-when-orphaned-and-empty",
];

/**
 * `<staged> --supervisor ...` in its own session (`detached` = `setsid`), stdio to `host.log`, so
 * killing the backend's process group leaves the host running.
 */
export async function launchLocalTerminalHost(
  input: LaunchLocalTerminalHostInput,
): Promise<LaunchedLocalTerminalHost> {
  const spawn = input.spawn ?? (nodeSpawn as unknown as LocalTerminalHostSpawn);
  const log = openSync(input.generation.logPath, "a", 0o600);
  let child: ReturnType<LocalTerminalHostSpawn>;
  try {
    child = spawn(input.binaryPath, LOCAL_TERMINAL_HOST_ARGS, {
      cwd: homedir(),
      detached: true,
      stdio: ["ignore", log, log],
      env: localTerminalHostEnvironment(
        input.environment ?? process.env,
        input.generation.statePath,
      ),
    });
  } finally {
    closeSync(log);
  }
  let exited = child.exitCode !== null || child.signalCode !== null;
  let spawnError: Error | undefined;
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", (error: Error) => {
    spawnError = error;
    exited = true;
  });
  child.unref();
  const deadline = Date.now() + (input.socketWaitMs ?? SOCKET_WAIT_MS);
  const pollMs = input.pollMs ?? SOCKET_POLL_MS;
  for (;;) {
    if (spawnError)
      throw new LocalTerminalHostLaunchError(
        `Terminal host failed to start: ${spawnError.message}`,
      );
    if (exited)
      throw new LocalTerminalHostLaunchError(
        `Terminal host exited during startup; see ${input.generation.logPath}.`,
      );
    try {
      const stat = await fs.lstat(input.generation.socketPath);
      if (stat.isSocket() && child.pid !== undefined) return { pid: child.pid };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    if (Date.now() >= deadline) {
      // Our own fresh host has no terminals yet; never leave a socketless process behind.
      child.kill("SIGTERM");
      throw new LocalTerminalHostLaunchError(
        `Terminal host socket did not appear within ${input.socketWaitMs ?? SOCKET_WAIT_MS} ms.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
