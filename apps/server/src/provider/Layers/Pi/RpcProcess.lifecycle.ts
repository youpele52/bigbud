import type { Readable, Writable } from "node:stream";

import type { PiRpcResponse } from "./RpcProcess.types.ts";

interface PendingResponse {
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: Error) => void;
}

/** Pipes of a local Pi child or of a typed SSH owner lease; never a synthetic child process. */
export interface PiRpcStdio {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

interface PiRpcProcessLifecycleOptions {
  readonly stdio: PiRpcStdio;
  readonly describeExit: (code: number | null, signal: string | null) => Error;
  readonly flushStdout: () => void;
  readonly cleanup: () => void;
}

export interface PiRpcProcessLifecycle {
  readonly addPending: (id: string, entry: PendingResponse) => void;
  /** Marks the transport as ended and fails every waiter with the described exit. */
  readonly end: (code: number | null, signal: string | null) => Error;
  readonly fail: (error: unknown) => Error;
  readonly processEnded: () => boolean;
  readonly removePending: (id: string) => PendingResponse | undefined;
  readonly terminalError: () => Error | undefined;
  readonly trackWrite: (reject: (error: Error) => void) => () => void;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createPiRpcProcessLifecycle(
  options: PiRpcProcessLifecycleOptions,
): PiRpcProcessLifecycle {
  const pending = new Map<string, PendingResponse>();
  const writes = new Set<(error: Error) => void>();
  let terminalError: Error | undefined;
  let processEnded = false;

  const fail = (error: unknown): Error => {
    if (terminalError) {
      return terminalError;
    }

    terminalError = toError(error);
    options.cleanup();
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timeout);
      entry.reject(terminalError);
    }
    for (const reject of writes) {
      reject(terminalError);
    }
    writes.clear();
    return terminalError;
  };

  const end = (code: number | null, signal: string | null) => {
    processEnded = true;
    return fail(options.describeExit(code, signal));
  };

  // These listeners must remain attached: removing the last `error` listener
  // from a Node stream makes a later EPIPE terminate the server process.
  options.stdio.stdin.on("error", fail);
  options.stdio.stdout.on("error", (error) => {
    options.flushStdout();
    fail(error);
  });
  options.stdio.stderr.on("error", (error) => {
    // stderr loss is diagnostic only; stdout and stdin remain usable.
    void error;
  });

  return {
    addPending: (id, entry) => {
      pending.set(id, entry);
    },
    end,
    fail,
    processEnded: () => processEnded,
    removePending: (id) => {
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
      }
      return entry;
    },
    terminalError: () => terminalError,
    trackWrite: (reject) => {
      if (terminalError) {
        reject(terminalError);
        return () => undefined;
      }
      writes.add(reject);
      return () => {
        writes.delete(reject);
      };
    },
  };
}
