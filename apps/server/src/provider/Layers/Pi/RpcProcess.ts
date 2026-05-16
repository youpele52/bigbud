import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts";

import { buildPiRpcInvocation } from "./Cli.ts";
import {
  createPiRemoteWorkspaceBridge,
  type PiRemoteWorkspaceBridge,
} from "./PiRemoteWorkspaceBridge.ts";
import { buildSshCommandInvocation } from "../../../ssh/sshCommand.ts";
import { assertSshExecutionTargetReady } from "../../../ssh/sshVerification.ts";
import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import {
  isLocalWorkspaceTarget,
  isRemoteWorkspaceTarget,
} from "../../../workspace-target/workspaceTarget.ts";
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
): Promise<PiRemoteWorkspaceBridge | undefined> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPiRpcResponse(message: unknown): message is PiRpcResponse {
  return isRecord(message) && message.type === "response" && typeof message.command === "string";
}

function formatMissingRemotePiBinaryDetail(input: {
  readonly binaryPath: string;
  readonly stderrTail: string;
}): string | null {
  const stderr = input.stderrTail.trim();
  if (!/exec:\s+.+:\s+not found/i.test(stderr)) {
    return null;
  }

  if (input.binaryPath === "pi") {
    return "Remote Pi CLI is not installed or not available on PATH. Install 'pi' on the remote host or set Providers > Pi > Binary path to the remote executable path.";
  }

  return `Remote Pi CLI was not found at '${input.binaryPath}'. Update Providers > Pi > Binary path to the correct remote executable path.`;
}

function describePiExit(input: {
  readonly command: string;
  readonly binaryPath: string;
  readonly executionTargetId: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
}): Error {
  const missingRemoteBinaryDetail =
    input.executionTargetId !== LOCAL_EXECUTION_TARGET_ID
      ? formatMissingRemotePiBinaryDetail({
          binaryPath: input.binaryPath,
          stderrTail: input.stderrTail,
        })
      : null;
  if (missingRemoteBinaryDetail) {
    return new Error(missingRemoteBinaryDetail);
  }

  const stderr = input.stderrTail.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(
    `Pi RPC process '${input.command}' exited (code=${input.code ?? "null"}, signal=${input.signal ?? "null"}).${detail}`,
  );
}

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
    try {
      child = spawn(invocation.command, invocation.args, {
        ...(localSpawnCwd ? { cwd: localSpawnCwd } : {}),
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      void bridge?.cleanup().catch(() => undefined);
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

    const cleanupBridge = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      void bridge?.cleanup().catch(() => undefined);
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
      cleanupBridge();
      rejectAllPending(error instanceof Error ? error : new Error(String(error)));
    });

    child.once("exit", (code, signal) => {
      closed = true;
      cleanupBridge();
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

    const stop = async () => {
      if (exitPromise) {
        return exitPromise;
      }

      exitPromise = new Promise<void>((resolve) => {
        if (closed || child.exitCode !== null) {
          cleanupBridge();
          resolve();
          return;
        }

        child.once("exit", () => {
          cleanupBridge();
          resolve();
        });

        const sigkillTimer = setTimeout(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }, 1_000);
        child.once("exit", () => clearTimeout(sigkillTimer));

        child.kill("SIGTERM");
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
