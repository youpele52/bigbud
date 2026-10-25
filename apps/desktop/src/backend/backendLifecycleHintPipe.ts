import * as FS from "node:fs";

import type {
  DesktopLifecycleHint,
  DesktopLifecycleHintKind,
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
 */
export class BackendLifecycleHintPipe {
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly stream: LifecycleHintStream,
    private readonly deps: LifecycleHintPipeDeps,
  ) {
    stream.on("error", (error) => {
      this.closed = true;
      deps.log("hint_fd5_error", `error=${error instanceof Error ? error.message : String(error)}`);
    });
    stream.on("close", () => {
      this.closed = true;
    });
  }

  write(hint: Omit<DesktopLifecycleHint, "sequence">): boolean {
    if (this.closed || this.stream.destroyed) return false;
    this.sequence += 1;
    const line = `${JSON.stringify({ ...hint, sequence: this.sequence })}\n`;
    // logind releases its sleep delay lock as soon as the suspend handler
    // returns, so on Linux the suspend line must reach the kernel before then.
    if (hint.kind === "suspend" && this.deps.platform === "linux" && this.writeNow(line)) {
      return true;
    }
    return this.queue(line);
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
