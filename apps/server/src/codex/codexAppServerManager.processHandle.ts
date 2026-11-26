import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

import { killCodexChildProcess } from "../provider/codexAppServer.ts";
import type { OwnedCodexAppServer } from "./codexAppServerManager.process.remote.owner.ts";

/**
 * The narrow process surface the Codex app-server manager uses: JSON-RPC pipes, liveness and
 * `exit`/`error`/`close` events. A local `ChildProcess` satisfies it structurally. An SSH owner
 * lease implements it with {@link OwnedCodexAppServerProcess}, which has no PID and reports only
 * what the owner confirmed; it is not a fabricated child.
 *
 * @module codexAppServerManager.processHandle
 */
export interface CodexAppServerProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
}

/**
 * An owner lease as a Codex app-server process. `exit` fires once with the owner-confirmed
 * outcome: the provider's exit code, `SIGKILL` after this side's own close, or `SIGHUP` when the
 * owner reported the transport lost without an exit. A loss also emits `error` when a listener
 * exists (an unobserved `error` event would otherwise throw).
 */
export class OwnedCodexAppServerProcess extends EventEmitter implements CodexAppServerProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private settled = false;

  constructor(private readonly lease: OwnedCodexAppServer) {
    super();
    this.stdin = lease.stdin;
    this.stdout = lease.stdout;
    this.stderr = lease.stderr;
    lease.exit.then(
      (exit) =>
        exit.kind === "exited"
          ? this.settle(exit.code, null)
          : this.settle(null, exit.signal as NodeJS.Signals),
      (error: unknown) => {
        if (this.listenerCount("error") > 0)
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        this.settle(null, "SIGHUP");
      },
    );
  }

  /** Confirmed close of this exact lease; idempotent. */
  terminate(): void {
    if (this.killed) return;
    this.killed = true;
    this.lease.cancel().then(
      () => this.settle(null, "SIGKILL"),
      (error: unknown) => {
        if (this.listenerCount("error") > 0)
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        this.settle(null, "SIGHUP");
      },
    );
  }

  private settle(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return;
    this.settled = true;
    this.killed = true;
    this.exitCode = code;
    this.signalCode = code === null ? signal : null;
    this.emit("exit", this.exitCode, this.signalCode);
    this.emit("close", this.exitCode, this.signalCode);
  }
}

/** Kills a local process tree, or closes an owner lease through its own confirmed cancel. */
export function terminateCodexAppServerProcess(process: CodexAppServerProcess): void {
  if (process instanceof OwnedCodexAppServerProcess) process.terminate();
  else killCodexChildProcess(process as ChildProcessWithoutNullStreams);
}
