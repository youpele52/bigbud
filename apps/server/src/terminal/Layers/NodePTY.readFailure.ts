import type { IPty } from "node-pty";

/** Owns only this PTY shell: no PID lookups, process groups, descendants or synthetic exits. */
export class NodePtyReadFailure {
  private failure: Error | undefined;
  private exited = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(error: Error) => void>();

  constructor(
    private readonly process: Pick<IPty, "kill" | "onExit">,
    private readonly graceMs = 1_000,
  ) {
    const exitSubscription = process.onExit(() => {
      this.exited = true;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.listeners.clear();
      exitSubscription.dispose();
    });
  }

  assertUsable(): void {
    if (this.failure) throw this.failure;
  }

  get failed(): boolean {
    return this.failure !== undefined;
  }

  onError(callback: (error: Error) => void): () => void {
    if (this.exited) return () => undefined;
    this.listeners.add(callback);
    // The read socket can fail between spawn and manager subscription.
    if (this.failure) this.notify(callback, this.failure);
    return () => this.listeners.delete(callback);
  }

  fail(cause: unknown, report: () => void): void {
    if (this.failure || this.exited) return;
    this.failure = new Error(
      `Terminal PTY read failed: ${cause instanceof Error ? cause.message : String(cause)}. Shutdown is not yet confirmed.`,
      { cause },
    );
    try {
      report();
    } catch {
      // Diagnostics must never escape node-pty's socket error handler or prevent containment.
    }
    for (const listener of this.listeners) this.notify(listener, this.failure);
    this.signal("SIGHUP", () => this.signal("SIGTERM", () => this.signal("SIGKILL")));
  }

  private notify(callback: (error: Error) => void, error: Error): void {
    try {
      callback(error);
    } catch {
      // A consumer must not crash the native read-error path or cancel escalation.
    }
  }

  private signal(signal: string, next?: () => void): void {
    if (this.exited) return;
    try {
      this.process.kill(signal);
    } catch {
      // A failed signal is not exit evidence. Still attempt the remaining bounded escalation.
    }
    if (!this.exited && next) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        next();
      }, this.graceMs);
      this.timer.unref?.();
    }
  }
}
