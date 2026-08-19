import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { PiRpcResponse } from "./RpcProcess.types.ts";

interface PendingResponse {
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: Error) => void;
}

interface PiRpcProcessLifecycleOptions {
  readonly child: ChildProcessWithoutNullStreams;
  readonly describeExit: (code: number | null, signal: NodeJS.Signals | null) => Error;
  readonly flushStdout: () => void;
  readonly cleanup: () => void;
}

export interface PiRpcProcessLifecycle {
  readonly addPending: (id: string, entry: PendingResponse) => void;
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

  const failExit = (code: number | null, signal: NodeJS.Signals | null) => {
    processEnded = true;
    fail(options.describeExit(code, signal));
  };

  // These listeners must remain attached: removing the last `error` listener
  // from a Node stream makes a later EPIPE terminate the server process.
  options.child.stdin.on("error", fail);
  options.child.stdout.on("error", (error) => {
    options.flushStdout();
    fail(error);
  });
  options.child.stderr.on("error", (error) => {
    // stderr loss is diagnostic only; stdout and stdin remain usable.
    void error;
  });
  options.child.on("error", fail);
  options.child.once("exit", failExit);
  options.child.once("close", failExit);

  return {
    addPending: (id, entry) => {
      pending.set(id, entry);
    },
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
