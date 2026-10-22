/**
 * Pending Codex app-server starts, tracked per thread.
 *
 * A remote start awaits an SSH version check (up to 20 s) before its session is
 * registered, so `stopSession` and `stopAll` would otherwise find nothing to
 * stop and the remote app-server would start anyway. Each start runs under an
 * `AbortSignal` that `cancel` and `cancelAll` abort: the remote starter never
 * spawns once aborted, and `accept` kills a child that arrives after a cancel.
 *
 * @module codexAppServerManager.pendingStarts
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { takeEarlySpawnError } from "./codexAppServerManager.process.spawnError.ts";
import { killChildTree } from "./codexAppServerManager.utils";

export const CODEX_START_CANCELLED_MESSAGE =
  "Codex session stopped before its app-server process started.";

export interface CodexPendingStart {
  readonly signal: AbortSignal;
  /**
   * Ends the pending start with its child. Call it synchronously right before
   * the session is registered, so a stop always finds one or the other. Throws,
   * with the child killed, when the start was cancelled or the spawn failed.
   */
  readonly accept: (child: ChildProcessWithoutNullStreams) => ChildProcessWithoutNullStreams;
  /** Ends the pending start after its starter failed, and rethrows. */
  readonly fail: (error: unknown) => never;
}

export class CodexPendingStarts {
  private readonly byThread = new Map<ThreadId, Set<AbortController>>();

  /** Number of starts still awaiting their app-server process. */
  get size(): number {
    let total = 0;
    for (const controllers of this.byThread.values()) total += controllers.size;
    return total;
  }

  begin(threadId: ThreadId): CodexPendingStart {
    const controller = new AbortController();
    const controllers = this.byThread.get(threadId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.byThread.set(threadId, controllers);
    const finish = () => {
      controllers.delete(controller);
      if (controllers.size === 0 && this.byThread.get(threadId) === controllers) {
        this.byThread.delete(threadId);
      }
    };
    return {
      signal: controller.signal,
      accept: (child) => {
        finish();
        const spawnError = takeEarlySpawnError(child);
        if (spawnError !== undefined || controller.signal.aborted) {
          killChildTree(child);
          controller.signal.throwIfAborted();
          throw spawnError;
        }
        return child;
      },
      fail: (error) => {
        finish();
        throw error;
      },
    };
  }

  cancel(threadId: ThreadId): void {
    for (const controller of this.byThread.get(threadId) ?? []) {
      controller.abort(new Error(CODEX_START_CANCELLED_MESSAGE));
    }
  }

  cancelAll(): void {
    for (const threadId of this.byThread.keys()) this.cancel(threadId);
  }
}
