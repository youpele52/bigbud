import { spawn, type ChildProcess } from "node:child_process";

import { Effect, Layer } from "effect";

import { runProcess } from "../../../utils/processRunner.ts";
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
      if (result.timedOut) return { _tag: "timeout" };
      if (result.code === 0) return { _tag: "available" };
      return { _tag: "execution-failed" };
    } catch (cause) {
      return cause instanceof Error && cause.message.startsWith("Command not found:")
        ? { _tag: "missing" }
        : { _tag: "execution-failed" };
    }
  };
}

function resultIsAvailable(result: CliProxyCommandResult): boolean {
  return result._tag === "available";
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
    if (closed) return Promise.resolve({ _tag: "closed" });
    if (ownedChild && ownedChild.exitCode === null) {
      return Promise.resolve(
        ownedConfigPath === input.configPath
          ? { _tag: "started", reused: true }
          : { _tag: "direct-process-configuration-conflict" },
      );
    }
    if (starting) {
      return starting.configPath === input.configPath
        ? starting.promise
        : Promise.resolve({ _tag: "direct-process-configuration-conflict" });
    }
    const promise: Promise<CliProxyActivationResult> =
      (async (): Promise<CliProxyActivationResult> => {
        const homebrew =
          platform === "darwin"
            ? await commandRunner("brew", ["list", "--versions", "cliproxyapi"])
            : ({ _tag: "missing" } as const);
        const systemd =
          platform === "linux"
            ? await commandRunner("systemctl", ["--user", "cat", "cli-proxy-api.service"])
            : ({ _tag: "missing" } as const);
        const direct = await commandRunner("cli-proxy-api", ["--version"]);
        const strategy = selectCliProxyLaunchStrategy({
          platform,
          hasHomebrewService: resultIsAvailable(homebrew),
          hasSystemdUserUnit: resultIsAvailable(systemd),
          hasDirectBinary: resultIsAvailable(direct),
        });

        if (strategy === "homebrew" || strategy === "systemd-user") {
          return { _tag: "service-configuration-unverified" };
        }
        if (strategy !== "direct") return { _tag: "unavailable" };
        if (closed) return { _tag: "closed" };
        if (ownedChild && ownedChild.exitCode !== null) {
          ownedChild = undefined;
          ownedConfigPath = undefined;
        }
        if (!ownedChild) {
          try {
            const child = spawnDirect("cli-proxy-api", ["--config", input.configPath], {
              detached: platform !== "win32",
              stdio: ["ignore", "pipe", "pipe"],
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
          } catch {
            return { _tag: "startup-failed" };
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (closed) return { _tag: "closed" };
          if (!ownedChild || ownedChild.exitCode !== null) return { _tag: "startup-failed" };
        }
        return { _tag: "started", reused: false };
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
