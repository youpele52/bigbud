import { spawn, type ChildProcess } from "node:child_process";

import { Effect, Layer } from "effect";

import { runProcess, type ProcessRunResult } from "../../../utils/processRunner.ts";
import {
  CliProxyLifecycle,
  type CliProxyActivationResult,
  type CliProxyCommandResult,
  type CliProxyLaunchStrategy,
} from "../../Services/CliProxy/Lifecycle.ts";

const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 4_000;

export type CliProxyCommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
) => Promise<CliProxyCommandResult>;

export function selectCliProxyLaunchStrategy(input: {
  readonly platform: NodeJS.Platform;
  readonly hasHomebrewService: boolean;
  readonly hasSystemdUserUnit: boolean;
  readonly hasDirectBinary: boolean;
}): CliProxyLaunchStrategy {
  if (input.platform === "darwin") {
    return input.hasHomebrewService ? "homebrew" : input.hasDirectBinary ? "direct" : "none";
  }
  if (input.platform === "linux") {
    return input.hasSystemdUserUnit ? "systemd-user" : input.hasDirectBinary ? "direct" : "none";
  }
  return input.platform === "win32" && input.hasDirectBinary ? "direct" : "none";
}

function commandDetail(result: ProcessRunResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail.length > 0 ? detail.slice(0, 400) : `exit code ${result.code ?? "unknown"}`;
}

export function makeCliProxyCommandRunner(
  run: typeof runProcess = runProcess,
): CliProxyCommandRunner {
  return async (command, args) => {
    try {
      const result = await run(command, args, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        maxBufferBytes: COMMAND_OUTPUT_LIMIT_BYTES,
        outputMode: "truncate",
        allowNonZeroExit: true,
      });
      if (result.timedOut) return { _tag: "timeout", command };
      if (result.code === 0) return { _tag: "available" };
      return { _tag: "failed", command, detail: commandDetail(result) };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Command execution failed.";
      return detail.startsWith("Command not found:")
        ? { _tag: "missing", command }
        : { _tag: "failed", command, detail: detail.slice(0, 400) };
    }
  };
}

function resultIsAvailable(result: CliProxyCommandResult): boolean {
  return result._tag === "available";
}

function activationFailure(
  strategy: CliProxyLaunchStrategy,
  result?: CliProxyCommandResult,
): CliProxyActivationResult {
  const detail =
    result?._tag === "failed"
      ? result.detail
      : result?._tag === "timeout"
        ? `${result.command} timed out.`
        : result?._tag === "missing"
          ? `${result.command} is not installed.`
          : "No supported CLIProxyAPI launch strategy is available.";
  return { _tag: "unavailable", strategy: "none", detail: `${strategy}: ${detail}` };
}

export function makeCliProxyLifecycle(
  options: {
    readonly commandRunner?: CliProxyCommandRunner;
    readonly platform?: NodeJS.Platform;
    readonly spawnDirect?: typeof spawn;
  } = {},
) {
  const commandRunner = options.commandRunner ?? makeCliProxyCommandRunner();
  const platform = options.platform ?? process.platform;
  const spawnDirect = options.spawnDirect ?? spawn;
  let ownedChild: ChildProcess | undefined;
  let ownedConfigPath: string | undefined;
  let starting:
    | { readonly configPath: string; readonly promise: Promise<CliProxyActivationResult> }
    | undefined;
  let closed = false;

  const activate = (input: { readonly configPath: string }): Promise<CliProxyActivationResult> => {
    if (closed) {
      return Promise.resolve({
        _tag: "unavailable",
        strategy: "none",
        detail: "CLIProxyAPI lifecycle is closed.",
      });
    }
    if (ownedChild && ownedChild.exitCode === null) {
      if (ownedConfigPath === input.configPath) {
        return Promise.resolve({ _tag: "started", strategy: "direct" });
      }
      return Promise.resolve({
        _tag: "unavailable",
        strategy: "none",
        detail: `direct: CLIProxyAPI is already running with config '${ownedConfigPath}'.`,
      });
    }
    if (starting) {
      return starting.configPath === input.configPath
        ? starting.promise
        : Promise.resolve({
            _tag: "unavailable",
            strategy: "none",
            detail: `activation: CLIProxyAPI activation is already in progress for config '${starting.configPath}'.`,
          });
    }
    const promise = (async () => {
      const homebrew =
        platform === "darwin"
          ? await commandRunner("brew", ["list", "--versions", "cliproxyapi"])
          : ({ _tag: "missing", command: "brew" } as const);
      const systemd =
        platform === "linux"
          ? await commandRunner("systemctl", ["--user", "cat", "cli-proxy-api.service"])
          : ({ _tag: "missing", command: "systemctl" } as const);
      const direct = await commandRunner("cli-proxy-api", ["--version"]);
      const strategy = selectCliProxyLaunchStrategy({
        platform,
        hasHomebrewService: resultIsAvailable(homebrew),
        hasSystemdUserUnit: resultIsAvailable(systemd),
        hasDirectBinary: resultIsAvailable(direct),
      });

      if (strategy === "homebrew") {
        const result = await commandRunner("brew", ["services", "start", "cliproxyapi"]);
        return resultIsAvailable(result)
          ? ({ _tag: "started", strategy } as const)
          : activationFailure(strategy, result);
      }
      if (strategy === "systemd-user") {
        const result = await commandRunner("systemctl", ["--user", "start", "cli-proxy-api"]);
        return resultIsAvailable(result)
          ? ({ _tag: "started", strategy } as const)
          : activationFailure(strategy, result);
      }
      if (strategy === "direct") {
        if (closed) {
          return {
            _tag: "unavailable",
            strategy: "none",
            detail: "direct: CLIProxyAPI lifecycle was closed during activation.",
          } as const;
        }
        if (ownedChild && ownedChild.exitCode !== null) {
          ownedChild = undefined;
          ownedConfigPath = undefined;
        }
        if (!ownedChild) {
          try {
            const child = spawnDirect("cli-proxy-api", ["--config", input.configPath], {
              detached: platform !== "win32",
              stdio: "ignore",
              windowsHide: true,
            });
            ownedChild = child;
            ownedConfigPath = input.configPath;
            child.once("error", () => {
              if (ownedChild === child) {
                ownedChild = undefined;
                ownedConfigPath = undefined;
              }
            });
            child.once("exit", () => {
              if (ownedChild === child) {
                ownedChild = undefined;
                ownedConfigPath = undefined;
              }
            });
          } catch (cause) {
            return activationFailure(strategy, {
              _tag: "failed",
              command: "cli-proxy-api",
              detail:
                cause instanceof Error ? cause.message.slice(0, 400) : "Process start failed.",
            });
          }
        }
        return { _tag: "started", strategy } as const;
      }
      return activationFailure(strategy);
    })().finally(() => {
      if (starting?.configPath === input.configPath) starting = undefined;
    });
    starting = { configPath: input.configPath, promise };
    return promise;
  };

  return {
    isClaudeRunnable: (input: { readonly binaryPath: string }) =>
      commandRunner(input.binaryPath, ["--version"]),
    activate,
    close() {
      closed = true;
      const child = ownedChild;
      ownedChild = undefined;
      ownedConfigPath = undefined;
      if (!child || child.exitCode !== null) return;
      if (platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // The process may have exited before shutdown reached it.
        }
      }
      child.kill();
    },
  };
}

export const CliProxyLifecycleLive = Layer.effect(
  CliProxyLifecycle,
  Effect.acquireRelease(Effect.sync(makeCliProxyLifecycle), (lifecycle) =>
    Effect.sync(lifecycle.close),
  ),
);
