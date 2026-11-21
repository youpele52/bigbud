import * as FS from "node:fs";

import type {
  DesktopLifecycleHint,
  DesktopLifecycleHintKind,
  DesktopQuitHint,
  DesktopQuitReason,
} from "@bigbud/contracts/server/desktopLifecycleHint.ts";

/**
 * Child stdio index of the main-to-server hint pipe. Must equal the contract's
 * `DESKTOP_LIFECYCLE_HINT_FD` (5), which the server reads.
 */
export const BACKEND_LIFECYCLE_HINT_STDIO_INDEX = 5;

const HINT_KINDS: ReadonlySet<string> = new Set<DesktopLifecycleHintKind>([
  "suspend",
  "resume",
  "online",
  "offline",
]);

export function isDesktopLifecycleHintKind(kind: string): kind is DesktopLifecycleHintKind {
  return HINT_KINDS.has(kind);
}

/** The parent's end of the child's fd 5 pipe, as `child.stdio[5]` exposes it. */
export interface LifecycleHintStream {
  write(chunk: string | Uint8Array): boolean;
  on(event: "error" | "close", listener: (...args: unknown[]) => void): unknown;
  readonly writableLength?: number;
  readonly destroyed?: boolean;
}

/** The child's fd 5 stream, or null when spawn did not open the pipe. */
export function asLifecycleHintStream(stream: unknown): LifecycleHintStream | null {
  return stream !== null && typeof stream === "object" && "write" in stream
    ? (stream as LifecycleHintStream)
    : null;
}

export interface LifecycleHintPipeDeps {
  readonly platform: NodeJS.Platform;
  readonly log: (event: string, details: string) => void;
  /** Returns the number of bytes written, as `fs.writeSync` does. */
  readonly writeSync?: (fd: number, bytes: Uint8Array) => number;
}

/** Native fd behind a Node pipe socket, when the platform exposes one. */
function nativeFd(stream: LifecycleHintStream): number | null {
  const handle = (stream as { readonly _handle?: { readonly fd?: unknown } })._handle;
  return typeof handle?.fd === "number" && handle.fd >= 0 ? handle.fd : null;
}

/**
 * Writes newline-delimited lifecycle hints for one backend lifetime. The pipe is
 * opened at spawn and owned by Electron main only, so a renderer cannot forge a
 * hint. Sequence numbers restart with each backend.
 *
 * A `quit` line shares the sequence counter. The server acknowledges it with a
 * `DesktopLifecycleHintAck` on the fd 4 status pipe, which `acknowledge` resolves.
 */
export class BackendLifecycleHintPipe {
  private sequence = 0;
  private closed = false;
  /** The latest known `net.isOnline()` result, repeated on quit lines. */
  private online: boolean | null = null;
  private ackedThrough = 0;
  private readonly ackWaiters = new Set<{
    readonly sequence: number;
    readonly settle: (acked: boolean) => void;
  }>();

  constructor(
    private readonly stream: LifecycleHintStream,
    private readonly deps: LifecycleHintPipeDeps,
  ) {
    stream.on("error", (error) => {
      this.close();
      deps.log("hint_fd5_error", `error=${error instanceof Error ? error.message : String(error)}`);
    });
    stream.on("close", () => {
      this.close();
    });
  }

  write(hint: Omit<DesktopLifecycleHint, "sequence">): boolean {
    if (this.closed || this.stream.destroyed) return false;
    if (hint.online !== null) this.online = hint.online;
    this.sequence += 1;
    const line = `${JSON.stringify({ ...hint, sequence: this.sequence })}\n`;
    // logind releases its sleep delay lock as soon as the suspend handler
    // returns, so on Linux the suspend line must reach the kernel before then.
    if (hint.kind === "suspend" && this.deps.platform === "linux" && this.writeNow(line)) {
      return true;
    }
    return this.queue(line);
  }

  /** Writes a quit line and returns its sequence, or null when the pipe is closed. */
  writeQuit(reason: DesktopQuitReason, occurredAt: number = Date.now()): number | null {
    if (this.closed || this.stream.destroyed) return null;
    this.sequence += 1;
    const hint: DesktopQuitHint = {
      kind: "quit",
      sequence: this.sequence,
      occurredAt,
      online: this.online,
      reason,
    };
    return this.queue(`${JSON.stringify(hint)}\n`) ? hint.sequence : null;
  }

  /** Records the server's ack; every waiter at or below `sequence` resolves true. */
  acknowledge(sequence: number): void {
    if (sequence <= this.ackedThrough) return;
    this.ackedThrough = sequence;
    for (const waiter of this.ackWaiters) {
      if (waiter.sequence <= sequence) waiter.settle(true);
    }
  }

  /**
   * Resolves true once the server acked `sequence`, or false after `timeoutMs` or when the
   * backend's pipe closes first. Never rejects.
   */
  waitForAck(sequence: number, timeoutMs: number): Promise<boolean> {
    if (sequence <= this.ackedThrough) return Promise.resolve(true);
    if (this.closed || this.stream.destroyed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = {
        sequence,
        settle: (acked: boolean) => {
          clearTimeout(timer);
          this.ackWaiters.delete(waiter);
          resolve(acked);
        },
      };
      const timer = setTimeout(() => waiter.settle(false), timeoutMs);
      this.ackWaiters.add(waiter);
    });
  }

  private close(): void {
    this.closed = true;
    for (const waiter of this.ackWaiters) waiter.settle(false);
  }

  /** The stream write; a closed or broken pipe (EPIPE) ends this pipe, never the caller. */
  private queue(chunk: string | Uint8Array): boolean {
    try {
      this.stream.write(chunk);
      return true;
    } catch (error) {
      this.closed = true;
      this.deps.log("hint_fd5_write_failed", `error=${String(error)}`);
      return false;
    }
  }

  private writeNow(line: string): boolean {
    // Only when nothing is queued, so a synchronous write cannot overtake it.
    if ((this.stream.writableLength ?? 0) > 0) return false;
    const fd = nativeFd(this.stream);
    if (fd === null) return false;
    const bytes = Buffer.from(line, "utf8");
    let written: number;
    try {
      written = (this.deps.writeSync ?? ((target, chunk) => FS.writeSync(target, chunk)))(
        fd,
        bytes,
      );
    } catch (error) {
      // A full or non-blocking pipe falls back to the queued write.
      this.deps.log("hint_fd5_sync_write_failed", `error=${String(error)}`);
      return false;
    }
    if (written <= 0) return false;
    if (written < bytes.length) {
      // A short write: the rest follows through the stream, so the line stays whole.
      this.deps.log("hint_fd5_sync_write_partial", `written=${written} total=${bytes.length}`);
      return this.queue(bytes.subarray(written));
    }
    return true;
  }
}

let activePipe: BackendLifecycleHintPipe | null = null;

/** Replaces the hint pipe with the one of a newly spawned backend. */
export function attachBackendLifecycleHintPipe(
  stream: LifecycleHintStream,
  deps: LifecycleHintPipeDeps,
): BackendLifecycleHintPipe {
  activePipe = new BackendLifecycleHintPipe(stream, deps);
  return activePipe;
}

/** Drops the hint pipe of a backend that exited; a no-op for a newer backend's pipe. */
export function detachBackendLifecycleHintPipe(pipe: BackendLifecycleHintPipe): void {
  if (activePipe === pipe) activePipe = null;
}

/** Forwards one power or network hint to the running backend, if any. */
export function writeBackendLifecycleHint(hint: Omit<DesktopLifecycleHint, "sequence">): boolean {
  return activePipe?.write(hint) ?? false;
}

/** A quit line written to the running backend, with a way to wait for its ack. */
export interface BackendQuitHint {
  readonly sequence: number;
  /** True when the server acked within `timeoutMs`; false on timeout or backend exit. */
  readonly acknowledged: (timeoutMs: number) => Promise<boolean>;
}

/** Announces quit intent to the running backend, or returns null when none can hear it. */
export function writeBackendQuitHint(reason: DesktopQuitReason): BackendQuitHint | null {
  const pipe = activePipe;
  const sequence = pipe?.writeQuit(reason) ?? null;
  if (pipe === null || sequence === null) return null;
  return { sequence, acknowledged: (timeoutMs) => pipe.waitForAck(sequence, timeoutMs) };
}

/** Forwards a `DesktopLifecycleHintAck` from the status pipe to the running backend's pipe. */
export function acknowledgeBackendLifecycleHint(sequence: number): void {
  activePipe?.acknowledge(sequence);
}
