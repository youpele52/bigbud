import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import { createPiRpcProcessLifecycle, type PiRpcStdio } from "./RpcProcess.lifecycle.ts";
import { isPiRpcResponse } from "./RpcProcess.message.ts";
import { serializePiPromptRequests } from "./RpcProcess.promptDispatch.ts";
import { createPiStdoutReader } from "./RpcProcess.stdout.ts";
import type {
  PiRpcCommand,
  PiRpcProcess,
  PiRpcRequestCommand,
  PiRpcResponse,
  PiRpcStdoutMessage,
} from "./RpcProcess.types.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_MAX_CHARS = 4_096;

function nextStderrTail(previous: string, chunk: string): string {
  const next = `${previous}${chunk}`;
  return next.length > STDERR_TAIL_MAX_CHARS ? next.slice(-STDERR_TAIL_MAX_CHARS) : next;
}

function writeJsonLine(
  stdin: Writable,
  lifecycle: ReturnType<typeof createPiRpcProcessLifecycle>,
  command: PiRpcCommand,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const terminalError = lifecycle.terminalError();
    if (terminalError) {
      reject(terminalError);
      return;
    }
    const untrackWrite = lifecycle.trackWrite(reject);
    if (!stdin.writable) {
      const error = lifecycle.fail(new Error("Pi RPC stdin is no longer writable."));
      untrackWrite();
      reject(error);
      return;
    }

    try {
      stdin.write(`${JSON.stringify(command)}\n`, (error) => {
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

export interface PiRpcTransport {
  readonly lifecycle: ReturnType<typeof createPiRpcProcessLifecycle>;
  readonly stderrTail: () => string;
  readonly request: PiRpcProcess["request"];
  readonly write: PiRpcProcess["write"];
  readonly subscribe: PiRpcProcess["subscribe"];
  /** Marks the transport as ended and fails every pending RPC request. */
  readonly end: (code: number | null, signal: string | null) => void;
}

/**
 * One JSON-lines RPC transport over already-authorized pipes. Callers own how the pipes
 * came to exist: a local child or the typed SSH owner lease.
 */
export function createPiRpcTransport(input: {
  readonly stdio: PiRpcStdio;
  readonly describeExit: (code: number | null, signal: string | null) => Error;
  readonly cleanup: () => void;
  /** Ends the owning transport after a protocol violation such as an oversized record. */
  readonly killOnOverflow: () => void;
}): PiRpcTransport {
  const { stdio } = input;
  const listeners = new Set<(message: PiRpcStdoutMessage) => void>();
  let stderrTail = "";
  let lifecycle: ReturnType<typeof createPiRpcProcessLifecycle>;

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

  // F-B5: a record longer than the limit is a protocol error that ends the session.
  const stdoutReader = createPiStdoutReader({
    onLine: handleLine,
    onOverflow: (error) => {
      lifecycle.fail(error);
      input.killOnOverflow();
    },
  });

  lifecycle = createPiRpcProcessLifecycle({
    stdio,
    cleanup: input.cleanup,
    describeExit: input.describeExit,
    flushStdout: stdoutReader.flush,
  });

  stdio.stdout.on("data", stdoutReader.push);
  stdio.stdout.on("end", () => {
    stdoutReader.flush();
  });

  stdio.stderr.setEncoding("utf8");
  stdio.stderr.on("data", (chunk: string) => {
    stderrTail = nextStderrTail(stderrTail, chunk);
  });
  stdio.stderr.on("error", (error) => {
    stderrTail = nextStderrTail(stderrTail, `[Pi RPC stderr stream error: ${String(error)}]`);
  });

  const request = async <TData = unknown>(
    command: PiRpcRequestCommand & { readonly id?: string },
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<PiRpcResponse<TData>> => {
    const terminalError = lifecycle.terminalError();
    if (terminalError) {
      throw terminalError;
    }
    if (lifecycle.processEnded()) {
      throw lifecycle.fail(input.describeExit(null, null));
    }

    const id = command.id ?? `pi-${randomUUID()}`;
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

      void writeJsonLine(stdio.stdin, lifecycle, { ...command, id }).catch((error) => {
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

  return {
    lifecycle,
    stderrTail: () => stderrTail,
    request: serializePiPromptRequests(request),
    write: (command) => writeJsonLine(stdio.stdin, lifecycle, command),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    end: (code, signal) => {
      lifecycle.end(code, signal);
    },
  };
}
