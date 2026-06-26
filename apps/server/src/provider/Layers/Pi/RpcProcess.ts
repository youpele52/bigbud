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

  return createPiRemoteWorkspaceBridge(options.workspaceTarget);
}

interface PendingResponse {
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_MAX_CHARS = 4_096;

function nextStderrTail(previous: string, chunk: string): string {
  const next = `${previous}${chunk}`;
  return next.length > STDERR_TAIL_MAX_CHARS ? next.slice(-STDERR_TAIL_MAX_CHARS) : next;
}

function writeJsonLine(
  child: ChildProcessWithoutNullStreams,
  command: PiRpcCommand,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.stdin.writable) {
      reject(new Error("Pi RPC stdin is no longer writable."));
      return;
    }

    child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
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
    const pending = new Map<string, PendingResponse>();
    const decoder = new StringDecoder("utf8");
    let stdoutBuffer = "";
    let stderrTail = "";
    let closed = false;
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

    const rejectAllPending = (error: Error) => {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timeout);
        entry.reject(error);
        pending.delete(id);
      }
    };

    const handleMessage = (message: PiRpcStdoutMessage) => {
      if (isPiRpcResponse(message) && typeof message.id === "string") {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
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
      stdoutBuffer += decoder.end();
      if (stdoutBuffer.length > 0) {
        handleLine(stdoutBuffer);
        stdoutBuffer = "";
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = nextStderrTail(stderrTail, chunk);
    });

    child.once("error", (error) => {
      closed = true;
      cleanupBridgeOnce();
      rejectAllPending(error instanceof Error ? error : new Error(String(error)));
    });

    child.once("exit", (code, signal) => {
      closed = true;
      cleanupBridgeOnce();
      rejectAllPending(
        describePiExit({
          command: invocation.command,
          binaryPath: options.binaryPath,
          executionTargetId,
          code,
          signal,
          stderrTail,
        }),
      );
    });

    const request = async <TData = unknown>(
      command: PiRpcRequestCommand,
      timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<PiRpcResponse<TData>> => {
      if (closed || child.exitCode !== null) {
        throw describePiExit({
          command: invocation.command,
          binaryPath: options.binaryPath,
          executionTargetId,
          code: child.exitCode,
          signal: null,
          stderrTail,
        });
      }

      const id = `pi-${randomUUID()}`;
      const response = await new Promise<PiRpcResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for Pi RPC response to '${command.type}'.`));
        }, timeoutMs);

        pending.set(id, {
          timeout,
          resolve,
          reject,
        });

        void writeJsonLine(child, { ...command, id }).catch((error) => {
          const entry = pending.get(id);
          if (!entry) {
            return;
          }
          pending.delete(id);
          clearTimeout(entry.timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });

      return response as PiRpcResponse<TData>;
    };

    const write = (command: PiRpcCommand) => writeJsonLine(child, command);

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
        if (closed || child.exitCode !== null) {
          cleanupBridgeOnce();
          resolve();
          return;
        }

        child.once("exit", () => {
          cleanupBridgeOnce();
          resolve();
        });

        const sigkillTimer = setTimeout(() => {
          if (child.exitCode === null) {
            killPiChild("SIGKILL");
          }
        }, 1_000);
        child.once("exit", () => clearTimeout(sigkillTimer));

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
