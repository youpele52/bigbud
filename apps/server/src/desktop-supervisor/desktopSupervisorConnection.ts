import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import {
  decodeDesktopSupervisorDelimitedFrame,
  encodeDesktopSupervisorDelimitedFrame,
} from "./desktopSupervisorProtocol.codec.ts";
import {
  DESKTOP_SUPERVISOR_MAX_FRAME_BYTES,
  DesktopSupervisorProtocolError,
  type DesktopSupervisorFrame,
} from "./desktopSupervisorProtocol.ts";
import { closeRemoteAgentProcess } from "../remote-agent/remoteAgentConnection.ts";

const STDERR_TAIL_BYTES = 4_096;
const UNMATCHED_FRAME_CAPACITY = 256;

type FrameWaiter = {
  readonly resolve: (frame: DesktopSupervisorFrame) => void;
  readonly reject: (error: Error) => void;
  readonly matches: (frame: DesktopSupervisorFrame) => boolean;
};

type RequestOptions = {
  readonly discardResponseOnAbort?: boolean;
  readonly signal?: AbortSignal;
};

export class DesktopSupervisorConnectionError extends Error {
  readonly _tag = "DesktopSupervisorConnectionError";

  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DesktopSupervisorConnectionError";
  }
}

export class DesktopSupervisorConnection {
  private readBuffer = Buffer.alloc(0);
  private stderrTail = "";
  private readonly queuedFrames: DesktopSupervisorFrame[] = [];
  private readonly lateResponseMatchers: Array<(frame: DesktopSupervisorFrame) => boolean> = [];
  private readonly waiters: FrameWaiter[] = [];
  private readonly frameListeners = new Set<(frame: DesktopSupervisorFrame) => boolean | void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private failure: Error | null = null;
  private closed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly maxFrameBytes: number,
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stdout.on("error", (error) => this.fail(error));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => {
      if (this.closed || this.failure) return;
      if (this.readBuffer.length > 0) {
        this.fail(new DesktopSupervisorProtocolError("supervisor output ended within a frame"));
        return;
      }
      const detail = this.stderrTail.trim();
      this.fail(
        new DesktopSupervisorConnectionError(
          `Desktop supervisor exited (code=${code ?? "null"}, signal=${signal ?? "null"})${detail ? `: ${detail}` : "."}`,
          "process_exit",
        ),
      );
    });
  }

  static spawn(input: {
    readonly binaryPath: string;
    readonly maxFrameBytes?: number;
    readonly environment?: NodeJS.ProcessEnv;
  }): DesktopSupervisorConnection {
    return new DesktopSupervisorConnection(
      spawn(input.binaryPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(input.environment ? { env: input.environment } : {}),
      }),
      input.maxFrameBytes ?? DESKTOP_SUPERVISOR_MAX_FRAME_BYTES,
    );
  }

  get processId(): number | undefined {
    return this.child.pid;
  }

  async send(frame: DesktopSupervisorFrame): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new DesktopSupervisorConnectionError("Connection is closed.");
    const encoded = encodeDesktopSupervisorDelimitedFrame(frame, this.maxFrameBytes);
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(Buffer.from(encoded), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async request(
    frame: DesktopSupervisorFrame,
    matches: (response: DesktopSupervisorFrame) => boolean,
    options?: RequestOptions,
  ): Promise<DesktopSupervisorFrame> {
    if (options?.signal?.aborted) {
      throw new DesktopSupervisorConnectionError("Request was cancelled.", "cancelled");
    }
    const queued = this.takeQueued(matches);
    if (queued) return this.assertResponse(queued);
    if (this.failure) throw this.failure;
    const response = await new Promise<DesktopSupervisorFrame>((resolve, reject) => {
      let waiter: FrameWaiter;
      const cleanup = () => options?.signal?.removeEventListener("abort", abort);
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        if (options?.discardResponseOnAbort) {
          this.lateResponseMatchers.push(matches);
          if (this.lateResponseMatchers.length > UNMATCHED_FRAME_CAPACITY) {
            this.lateResponseMatchers.shift();
          }
        }
        cleanup();
        reject(new DesktopSupervisorConnectionError("Request was cancelled.", "cancelled"));
      };
      waiter = {
        matches,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      this.waiters.push(waiter);
      options?.signal?.addEventListener("abort", abort, { once: true });
      void this.send(frame).catch((cause: unknown) => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(this.asError(cause));
      });
    });
    return this.assertResponse(response);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.failureListeners.delete(listener);
  }

  onFrame(listener: (frame: DesktopSupervisorFrame) => boolean | void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeRemoteAgentProcess(this.child);
    const error = new DesktopSupervisorConnectionError("Connection is closed.", "closed");
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private consume(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
    while (this.readBuffer.length >= 4) {
      const length = this.readBuffer.readUInt32BE(0);
      if (length === 0 || length > this.maxFrameBytes) {
        this.fail(new DesktopSupervisorProtocolError("supervisor frame length is invalid"));
        return;
      }
      if (this.readBuffer.length < length + 4) return;
      const frame = this.readBuffer.subarray(0, length + 4);
      this.readBuffer = this.readBuffer.subarray(length + 4);
      try {
        this.deliver(decodeDesktopSupervisorDelimitedFrame(frame, this.maxFrameBytes));
      } catch (cause) {
        this.fail(cause);
        return;
      }
    }
  }

  private deliver(frame: DesktopSupervisorFrame): void {
    let consumed = false;
    for (const listener of this.frameListeners) {
      if (listener(frame) === true) consumed = true;
    }
    const index = this.waiters.findIndex(
      (waiter) => frame.type === "protocolError" || waiter.matches(frame),
    );
    const waiter = index >= 0 ? this.waiters.splice(index, 1)[0] : undefined;
    if (waiter) waiter.resolve(frame);
    else if (!consumed) {
      const lateIndex = this.lateResponseMatchers.findIndex((matches) => matches(frame));
      if (lateIndex >= 0) {
        this.lateResponseMatchers.splice(lateIndex, 1);
        return;
      }
      if (this.queuedFrames.length >= UNMATCHED_FRAME_CAPACITY) {
        this.fail(
          new DesktopSupervisorProtocolError("supervisor unmatched frame capacity exceeded"),
        );
        return;
      }
      this.queuedFrames.push(frame);
    }
  }

  private takeQueued(
    matches: (frame: DesktopSupervisorFrame) => boolean,
  ): DesktopSupervisorFrame | undefined {
    const index = this.queuedFrames.findIndex(
      (frame) => frame.type === "protocolError" || matches(frame),
    );
    return index >= 0 ? this.queuedFrames.splice(index, 1)[0] : undefined;
  }

  private assertResponse(frame: DesktopSupervisorFrame): DesktopSupervisorFrame {
    if (frame.type === "protocolError") {
      throw new DesktopSupervisorConnectionError(
        `${frame.value.code}: ${frame.value.message}`,
        frame.value.code,
      );
    }
    return frame;
  }

  private fail(cause: unknown): void {
    if (this.failure || this.closed) return;
    this.failure = this.asError(cause);
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
    for (const listener of this.failureListeners) listener(this.failure);
    closeRemoteAgentProcess(this.child);
  }

  private asError(cause: unknown): Error {
    return cause instanceof Error
      ? cause
      : new DesktopSupervisorConnectionError(String(cause), "unknown");
  }
}
