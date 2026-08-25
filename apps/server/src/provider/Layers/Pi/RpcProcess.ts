import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import {
  buildPiRpcInvocation,
  quoteWindowsPiShellCommand,
  shouldUseWindowsPiShell,
} from "./Cli.ts";
import {
  createPiRemoteWorkspaceBridge,
  type PiRemoteWorkspaceExtensionBridge,
} from "./PiRemoteWorkspaceBridge.ts";
import { composeBridgeCleanups } from "../../../orchestration-tools/orchestrationMcpBridge.session.ts";
import { buildSshCommandInvocation } from "../../../ssh/sshCommand.ts";
import { assertSshExecutionTargetReady } from "../../../ssh/sshVerification.ts";
import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import {
  isLocalWorkspaceTarget,
  isRemoteWorkspaceTarget,
} from "../../../workspace-target/workspaceTarget.ts";
import { describePiExit } from "./RpcProcess.errors.ts";
import { createPiRpcProcessLifecycle, type PiRpcProcessLifecycle } from "./RpcProcess.lifecycle.ts";
import { isPiRpcResponse } from "./RpcProcess.message.ts";
import type {
  PiRpcCommand,
  PiRpcProcess,
  PiRpcProcessOptions,
  PiRpcRequestCommand,
  PiRpcResponse,
  PiRpcStdoutMessage,
} from "./RpcProcess.types.ts";

export type {
  PiRpcAssistantMessageEvent,
  PiRpcCommand,
  PiRpcExtensionUIRequest,
  PiRpcImage,
  PiRpcModel,
  PiRpcProcess,
  PiRpcProcessOptions,
  PiRpcRequestCommand,
  PiRpcResponse,
  PiRpcSessionState,
  PiRpcSlashCommand,
  PiRpcStdoutEvent,
  PiRpcStdoutMessage,
  PiRpcToolResult,
  PiRpcWriteOnlyCommand,
} from "./RpcProcess.types.ts";

function resolvePiRpcProcessInvocation(options: PiRpcProcessOptions): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  const rpcArgs = options.sessionFile ? ["--session", options.sessionFile] : [];
  if (isLocalProviderRuntimeTarget(options.providerRuntimeTarget)) {
    const invocation = buildPiRpcInvocation(options.binaryPath, rpcArgs);
    return {
      command: invocation.command,
      args: invocation.args,
    };
  }

  const executionTargetId = options.providerRuntimeTarget.executionTargetId;
  assertSshExecutionTargetReady(executionTargetId);
  return buildSshCommandInvocation({
    executionTargetId,
    command: options.binaryPath,
    args: ["--mode", "rpc", ...rpcArgs],
    ...(options.workspaceTarget.cwd ? { cwd: options.workspaceTarget.cwd } : {}),
  });
}

async function preparePiRpcProcessBridge(
  options: PiRpcProcessOptions,
): Promise<PiRemoteWorkspaceExtensionBridge | undefined> {
  if (
    !isLocalProviderRuntimeTarget(options.providerRuntimeTarget) ||
    !isRemoteWorkspaceTarget(options.workspaceTarget)
  ) {
    return undefined;
  }

  return createPiRemoteWorkspaceBridge(
    options.workspaceTarget,
    options.orchestrationBridge?.httpConfig,
  );
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_MAX_CHARS = 4_096;

function nextStderrTail(previous: string, chunk: string): string {
  const next = `${previous}${chunk}`;
  return next.length > STDERR_TAIL_MAX_CHARS ? next.slice(-STDERR_TAIL_MAX_CHARS) : next;
}

function writeJsonLine(
  child: ChildProcessWithoutNullStreams,
  lifecycle: PiRpcProcessLifecycle,
  command: PiRpcCommand,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const terminalError = lifecycle.terminalError();
    if (terminalError) {
      reject(terminalError);
      return;
    }
    const untrackWrite = lifecycle.trackWrite(reject);
    if (!child.stdin.writable) {
      const error = lifecycle.fail(new Error("Pi RPC stdin is no longer writable."));
      untrackWrite();
      reject(error);
      return;
    }

    try {
      child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (error) {
          untrackWrite();
          reject(lifecycle.fail(error));
          return;
        }
        untrackWrite();
        resolve();
      });
    } catch (error) {
      untrackWrite();
      reject(lifecycle.fail(error));
    }
  });
}

export function createPiRpcProcess(options: PiRpcProcessOptions): Promise<PiRpcProcess> {
  const executionTargetId = options.providerRuntimeTarget.executionTargetId;
  return preparePiRpcProcessBridge(options).then((bridge) => {
    const rpcArgs = [
      ...(options.sessionFile ? ["--session", options.sessionFile] : []),
      ...(bridge ? bridge.extraArgs : []),
      ...(options.orchestrationBridge ? options.orchestrationBridge.extraArgs : []),
    ];
    const invocation = isLocalProviderRuntimeTarget(options.providerRuntimeTarget)
      ? buildPiRpcInvocation(options.binaryPath, rpcArgs)
      : resolvePiRpcProcessInvocation(options);
    const localSpawnCwd =
      bridge?.cwd ??
      (isLocalProviderRuntimeTarget(options.providerRuntimeTarget) &&
      isLocalWorkspaceTarget(options.workspaceTarget)
        ? options.workspaceTarget.cwd
        : undefined);

    let child: ChildProcessWithoutNullStreams;
    const useWindowsShell =
      isLocalProviderRuntimeTarget(options.providerRuntimeTarget) &&
      shouldUseWindowsPiShell(invocation.command);
    const command = useWindowsShell
      ? quoteWindowsPiShellCommand(invocation.command)
      : invocation.command;
    try {
      child = spawn(command, invocation.args, {
        ...(localSpawnCwd ? { cwd: localSpawnCwd } : {}),
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: useWindowsShell,
      });
    } catch (error) {
      void composeBridgeCleanups(bridge?.cleanup, options.orchestrationBridge?.cleanup)().catch(
        () => undefined,
      );
      throw error;
    }

    const listeners = new Set<(message: PiRpcStdoutMessage) => void>();
    const decoder = new StringDecoder("utf8");
    let stdoutBuffer = "";
    let stderrTail = "";
    let exitPromise: Promise<void> | undefined;
    let cleanedUp = false;

    const cleanupBridge = composeBridgeCleanups(
      bridge?.cleanup,
      options.orchestrationBridge?.cleanup,
    );

    const cleanupBridgeOnce = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      void cleanupBridge().catch(() => undefined);
    };

    let lifecycle: PiRpcProcessLifecycle;

    const handleMessage = (message: PiRpcStdoutMessage) => {
      if (isPiRpcResponse(message) && typeof message.id === "string") {
        const entry = lifecycle.removePending(message.id);
        if (entry) {
          clearTimeout(entry.timeout);
          if (message.success) {
            entry.resolve(message);
          } else {
            entry.reject(new Error(message.error ?? `Pi RPC command '${message.command}' failed.`));
          }
        }
      }

      for (const listener of listeners) {
        listener(message);
      }
    };

    const handleLine = (line: string) => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.length === 0) {
        return;
      }

      try {
        const parsed = JSON.parse(trimmed) as PiRpcStdoutMessage;
        handleMessage(parsed);
      } catch {
        // Ignore malformed stdout records from Pi.
      }
    };

    const flushStdout = () => {
      stdoutBuffer += decoder.end();
      if (stdoutBuffer.length > 0) {
        handleLine(stdoutBuffer);
        stdoutBuffer = "";
      }
    };

    lifecycle = createPiRpcProcessLifecycle({
      child,
      cleanup: cleanupBridgeOnce,
      describeExit: (code, signal) =>
        describePiExit({
          command: invocation.command,
          binaryPath: options.binaryPath,
          executionTargetId,
          code,
          signal,
          stderrTail,
        }),
      flushStdout,
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutBuffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    });

    child.stdout.on("end", () => {
      flushStdout();
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = nextStderrTail(stderrTail, chunk);
    });
    child.stderr.on("error", (error) => {
      stderrTail = nextStderrTail(stderrTail, `[Pi RPC stderr stream error: ${String(error)}]`);
    });

    const request = async <TData = unknown>(
      command: PiRpcRequestCommand,
      timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<PiRpcResponse<TData>> => {
      const terminalError = lifecycle.terminalError();
      if (terminalError) {
        throw terminalError;
      }
      if (child.exitCode !== null) {
        throw lifecycle.fail(
          describePiExit({
            command: invocation.command,
            binaryPath: options.binaryPath,
            executionTargetId,
            code: child.exitCode,
            signal: null,
            stderrTail,
          }),
        );
      }

      const id = `pi-${randomUUID()}`;
      const response = await new Promise<PiRpcResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          lifecycle.removePending(id);
          reject(new Error(`Timed out waiting for Pi RPC response to '${command.type}'.`));
        }, timeoutMs);

        lifecycle.addPending(id, {
          timeout,
          resolve,
          reject,
        });

        void writeJsonLine(child, lifecycle, { ...command, id }).catch((error) => {
          const entry = lifecycle.removePending(id);
          if (!entry) {
            return;
          }
          clearTimeout(entry.timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });

      return response as PiRpcResponse<TData>;
    };

    const write = (command: PiRpcCommand) => writeJsonLine(child, lifecycle, command);

    const subscribe = (listener: (message: PiRpcStdoutMessage) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };

    const killPiChild = (signal: NodeJS.Signals) => {
      if (process.platform === "win32" && child.pid !== undefined) {
        try {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          return;
        } catch {
          // Fall through to direct kill when taskkill is unavailable.
        }
      }
      child.kill(signal);
    };

    const stop = async () => {
      if (exitPromise) {
        return exitPromise;
      }

      exitPromise = new Promise<void>((resolve) => {
        if (lifecycle.processEnded() || child.exitCode !== null) {
          cleanupBridgeOnce();
          resolve();
          return;
        }

        const settleStop = () => {
          cleanupBridgeOnce();
          resolve();
        };
        child.once("exit", settleStop);
        child.once("close", settleStop);

        const sigkillTimer = setTimeout(() => {
          if (child.exitCode === null) {
            killPiChild("SIGKILL");
          }
        }, 1_000);
        child.once("exit", () => clearTimeout(sigkillTimer));
        child.once("close", () => clearTimeout(sigkillTimer));

        killPiChild("SIGTERM");
      });

      return exitPromise;
    };

    return {
      child,
      command: invocation.command,
      args: invocation.args,
      ...(localSpawnCwd ? { cwd: localSpawnCwd } : {}),
      stderrTail: () => stderrTail,
      request,
      write,
      subscribe,
      stop,
    };
  });
}
