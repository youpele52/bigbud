/**
 * Lifecycle and request bookkeeping for one `node:sqlite` worker thread.
 *
 * Contract:
 * - Requests are answered in the order they were sent; the worker handles one
 *   statement at a time on its single connection.
 * - Opening is bounded by `openTimeoutMs`; a worker that has not reported
 *   `ready` by then is terminated and reported as a connection failure.
 * - If the worker throws, exits or fails to open, every pending request fails
 *   with the bridge failure and every later request fails immediately. There is
 *   no automatic restart: an open transaction cannot survive a lost connection.
 * - A caller that stops waiting (fiber interruption) does not cancel its
 *   statement. The statement still runs to completion in the worker and its
 *   result is discarded; later statements queue behind it. `node:sqlite`
 *   offers no way to interrupt a running statement from another thread.
 * - `close()` resolves only after the worker thread has exited (bounded by
 *   `exitTimeoutMs`), so the database file is released before anything reopens it.
 *
 * @module NodeSqliteClient.worker.bridge
 */
import { Worker } from "node:worker_threads";

import type {
  NodeSqliteWorkerOpenOptions,
  NodeSqliteWorkerRequest,
  NodeSqliteWorkerResponse,
} from "./NodeSqliteWorker.protocol.ts";

export type NodeSqliteWorkerResult = Extract<NodeSqliteWorkerResponse, { kind: "result" }>;
type ExecuteRequest = Omit<Extract<NodeSqliteWorkerRequest, { kind: "execute" }>, "id">;

export interface NodeSqliteWorkerBridgeTimeouts {
  readonly openTimeoutMs: number;
  readonly closeTimeoutMs: number;
  readonly exitTimeoutMs: number;
}

export const DEFAULT_NODE_SQLITE_WORKER_TIMEOUTS: NodeSqliteWorkerBridgeTimeouts = {
  openTimeoutMs: 30_000,
  closeTimeoutMs: 5_000,
  exitTimeoutMs: 10_000,
};

/** A failure of the bridge itself, as opposed to a failed SQL statement. */
export class NodeSqliteWorkerBridgeError extends Error {}

const activeBridges = new Set<NodeSqliteWorkerBridge>();
let lastActivityAt = 0;

/**
 * Resolves once no worker has had a request in flight for `quietMs`, or after
 * `timeoutMs` at the latest. Test harnesses that drive a `TestClock` use this
 * so fibers waiting on worker I/O re-arm their timers before the clock moves.
 */
export async function waitForNodeSqliteWorkersIdle(
  options: { readonly quietMs?: number; readonly timeoutMs?: number } = {},
): Promise<void> {
  const quietMs = options.quietMs ?? 20;
  const endsAt = performance.now() + (options.timeoutMs ?? 5_000);
  while (performance.now() < endsAt) {
    const busy = [...activeBridges].some((bridge) => bridge.pendingCount > 0);
    if (!busy && performance.now() - lastActivityAt >= quietMs) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export class NodeSqliteWorkerBridge {
  private readonly worker: Worker;
  private readonly pending = new Map<number, (response: NodeSqliteWorkerResult) => void>();
  private readonly exited: Promise<void>;
  private nextId = 1;
  private failureMessage: string | undefined;
  private failureCause: unknown;
  private onOpen: ((error: NodeSqliteWorkerBridgeError | undefined) => void) | undefined;

  constructor(
    entry: string,
    options: NodeSqliteWorkerOpenOptions,
    private readonly timeouts: NodeSqliteWorkerBridgeTimeouts = DEFAULT_NODE_SQLITE_WORKER_TIMEOUTS,
  ) {
    this.worker = new Worker(entry, { workerData: options });
    this.exited = new Promise((resolve) => this.worker.once("exit", () => resolve()));
    activeBridges.add(this);
    this.worker.on("message", (message: NodeSqliteWorkerResponse) => this.receive(message));
    this.worker.on("error", (cause) => this.fail(`SQLite worker crashed: ${cause.message}`, cause));
    this.worker.on("exit", (code) => {
      activeBridges.delete(this);
      this.fail(`SQLite worker exited with code ${code}.`, { code });
    });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Set once the bridge has failed; later requests fail with it immediately. */
  get failure(): { readonly message: string; readonly cause: unknown } | undefined {
    return this.failureMessage === undefined
      ? undefined
      : { message: this.failureMessage, cause: this.failureCause };
  }

  /** Waits for the worker to open the database, within `openTimeoutMs`. */
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failureMessage !== undefined) {
        reject(new NodeSqliteWorkerBridgeError(this.failureMessage, { cause: this.failureCause }));
        return;
      }
      const timer = setTimeout(() => {
        this.fail(
          `SQLite worker did not open the database within ${this.timeouts.openTimeoutMs} ms.`,
          undefined,
        );
        void this.worker.terminate();
      }, this.timeouts.openTimeoutMs);
      this.onOpen = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
    });
  }

  execute(request: ExecuteRequest, resolve: (response: NodeSqliteWorkerResult) => void): void {
    this.send({ ...request, id: this.nextId++ }, resolve);
  }

  /** Closes the database, then waits (bounded) for the worker thread to exit. */
  async close(): Promise<void> {
    if (this.failureMessage === undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.timeouts.closeTimeoutMs);
        this.send({ kind: "close", id: this.nextId++ }, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    void this.worker.terminate();
    await Promise.race([
      this.exited,
      new Promise((resolve) => setTimeout(resolve, this.timeouts.exitTimeoutMs)),
    ]);
    activeBridges.delete(this);
  }

  private send(request: NodeSqliteWorkerRequest, resolve: (r: NodeSqliteWorkerResult) => void) {
    if (this.failureMessage !== undefined) {
      resolve(this.failureResult(request.id, this.failureMessage));
      return;
    }
    this.pending.set(request.id, resolve);
    this.touch();
    try {
      // `worker_threads` ports have no target origin; the rule targets `window.postMessage`.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      this.worker.postMessage(request);
    } catch (cause) {
      // Parameters that cannot be cloned fail before reaching the worker.
      this.pending.delete(request.id);
      this.touch();
      resolve(
        this.failureResult(request.id, cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }

  private receive(message: NodeSqliteWorkerResponse): void {
    if (message.kind === "ready") {
      this.onOpen?.(undefined);
      this.onOpen = undefined;
      return;
    }
    if (message.kind === "open-failed") {
      this.fail(`SQLite worker could not open the database: ${message.error.message}`, message);
      return;
    }
    const resolve = this.pending.get(message.id);
    if (!resolve) return;
    this.pending.delete(message.id);
    this.touch();
    resolve(message);
  }

  private fail(message: string, cause: unknown): void {
    if (this.failureMessage === undefined) {
      this.failureMessage = message;
      this.failureCause = cause;
    }
    this.onOpen?.(new NodeSqliteWorkerBridgeError(message, { cause }));
    this.onOpen = undefined;
    const waiting = [...this.pending.entries()];
    this.pending.clear();
    this.touch();
    for (const [id, resolve] of waiting) resolve(this.failureResult(id, message));
  }

  private failureResult(id: number, message: string): NodeSqliteWorkerResult {
    return { kind: "result", id, ok: false, phase: "execute", error: { message } };
  }

  /** Keeps the process alive only while requests are in flight. */
  private touch(): void {
    lastActivityAt = performance.now();
    if (this.pending.size > 0) this.worker.ref();
    else this.worker.unref();
  }
}
