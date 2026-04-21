import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { buildPiRpcInvocation } from "./PiCli.ts";
import type {
  PiRpcCommand,
  PiRpcProcess,
  PiRpcProcessOptions,
  PiRpcRequestCommand,
  PiRpcResponse,
  PiRpcStdoutMessage,
} from "./PiRpcProcess.types.ts";

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
} from "./PiRpcProcess.types.ts";

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

function describePiExit(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string,
): Error {
  const stderr = stderrTail.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(
    `Pi RPC process '${command}' exited (code=${code ?? "null"}, signal=${signal ?? "null"}).${detail}`,
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
  const invocation = buildPiRpcInvocation(
    options.binaryPath,
    options.sessionFile ? ["--session", options.sessionFile] : [],
  );
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const listeners = new Set<(message: PiRpcStdoutMessage) => void>();
  const pending = new Map<string, PendingResponse>();
  const decoder = new StringDecoder("utf8");
  let stdoutBuffer = "";
  let stderrTail = "";
  let closed = false;
  let exitPromise: Promise<void> | undefined;

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
    rejectAllPending(error instanceof Error ? error : new Error(String(error)));
  });

  child.once("exit", (code, signal) => {
    closed = true;
    rejectAllPending(describePiExit(invocation.command, code, signal, stderrTail));
  });

  const request = async <TData = unknown>(
    command: PiRpcRequestCommand,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<PiRpcResponse<TData>> => {
    if (closed || child.exitCode !== null) {
      throw describePiExit(invocation.command, child.exitCode, null, stderrTail);
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
        resolve();
        return;
      }

      child.once("exit", resolve);

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

  return Promise.resolve({
    child,
    command: invocation.command,
    args: invocation.args,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stderrTail: () => stderrTail,
    request,
    write,
    subscribe,
    stop,
  });
}
