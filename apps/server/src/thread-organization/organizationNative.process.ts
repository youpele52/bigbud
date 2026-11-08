import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { OrganizationFrameReader } from "./organizationNative.framing.ts";
import { decodeOrganizationNativeFrame } from "./organizationScheduling.decode.ts";
import { encodeOrganizationDelimitedFrame } from "./organizationProtocol.encode.ts";
import type { OrganizationFrame, OrganizationNativeFrame } from "./organizationProtocol.ts";

type Owner = { backendNonce: string; generation: number };
type Input = Owner & {
  binary: string;
  receive: (frame: OrganizationNativeFrame, signal: AbortSignal) => Promise<void>;
  failed: (error: Error) => void;
};
const MAX_PENDING_FRAMES = 32;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const asError = (error: unknown) =>
  error instanceof Error ? error : new Error("native organisation failure");

/** One dedicated child and one serial receiver. Transport failure fences this instance permanently.
 * It does not retry moves, restart a child, choose sections or provide a fallback scheduler.
 */
export class OrganizationNativeProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly reader = new OrganizationFrameReader();
  private readonly receiverAbort = new AbortController();
  private readonly incoming: { frame: OrganizationNativeFrame; bytes: number }[] = [];
  private receiving = false;
  private pendingBytes = 0;
  private queuedWrites = 0;
  private stopped = false;
  private failure: Error | undefined;
  private exited: Promise<void> = Promise.resolve();
  private finishExit: (() => void) | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly writes = new Set<(error: Error) => void>();

  constructor(private readonly input: Input) {
    if (
      !input.backendNonce ||
      input.backendNonce.length > 256 ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1
    )
      throw new Error("invalid organisation process identity");
  }

  start(): void {
    if (this.child || this.stopped)
      throw new Error("organisation process already started or fenced");
    this.exited = new Promise((resolve) => {
      this.finishExit = resolve;
    });
    const child = spawn(
      this.input.binary,
      ["--thread-organization", this.input.backendNonce, String(this.input.generation)],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.child = child;
    child.on("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => this.fail(error));
    child.stdout.on("error", (error) => this.fail(error));
    // Drain without retaining or logging native diagnostics: facts must not leak to logs.
    child.stderr.on("data", () => {});
    child.stderr.on("error", (error) => this.fail(error));
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.stopped) return;
      try {
        this.reader.push(chunk, (bytes) => this.enqueue(bytes));
      } catch (error) {
        this.fail(asError(error));
      }
    });
    child.stdout.on("end", () => {
      if (this.stopped) return;
      try {
        this.reader.end();
      } catch (error) {
        this.fail(asError(error));
        return;
      }
      this.fail(new Error("native organisation output closed"));
    });
    child.on("close", () => {
      this.finishExit?.();
      if (!this.stopped) this.fail(new Error("native organisation process exited"));
    });
  }

  send(frame: OrganizationFrame): Promise<void> {
    if (
      frame.backendNonce !== this.input.backendNonce ||
      frame.generation !== this.input.generation
    )
      return Promise.reject(new Error("stale organisation outbound owner"));
    if (!this.child || this.stopped)
      return Promise.reject(this.failure ?? new Error("organisation process is not running"));
    let bytes: Uint8Array;
    try {
      bytes = encodeOrganizationDelimitedFrame(frame);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    if (
      this.queuedWrites + bytes.length > MAX_PENDING_BYTES ||
      this.writes.size >= MAX_PENDING_FRAMES
    ) {
      const error = new Error("native organisation input capacity exceeded");
      this.fail(error);
      return Promise.reject(error);
    }
    this.queuedWrites += bytes.length;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.writes.delete(abort);
        this.queuedWrites -= bytes.length;
        if (error) reject(error);
        else resolve();
      };
      const abort = (error: Error) => finish(error);
      const timer = setTimeout(() => {
        const error = new Error("native organisation write timed out");
        this.fail(error);
      }, 5000);
      this.writes.add(abort);
      this.child!.stdin.write(bytes, (error) => finish(error ?? undefined));
    });
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.shutdown();
    return this.stopPromise;
  }

  private async shutdown(): Promise<void> {
    this.fence(new Error("organisation process stopped"));
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (ms: number) =>
      Promise.race([
        this.exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]).finally(() => {
        clearTimeout(timer);
      });
    if (await wait(2000)) return;
    child.kill("SIGTERM");
    if (await wait(1000)) return;
    child.kill("SIGKILL");
    if (!(await wait(2000)))
      throw new Error("native organisation process did not exit within shutdown bound");
  }

  private enqueue(bytes: Uint8Array): void {
    if (this.stopped) return;
    const frame = decodeOrganizationNativeFrame(bytes);
    if (
      frame.backendNonce !== this.input.backendNonce ||
      frame.generation !== this.input.generation
    )
      throw new Error("stale native organisation owner");
    if (
      this.incoming.length + (this.receiving ? 1 : 0) >= MAX_PENDING_FRAMES ||
      this.pendingBytes + bytes.length > MAX_PENDING_BYTES
    )
      throw new Error("native organisation output capacity exceeded");
    this.incoming.push({ frame, bytes: bytes.length });
    this.pendingBytes += bytes.length;
    if (!this.receiving) void this.drain();
  }

  private async drain(): Promise<void> {
    this.receiving = true;
    try {
      while (!this.stopped) {
        const next = this.incoming.shift();
        if (!next) break;
        await this.consume(next.frame);
        this.pendingBytes -= next.bytes;
      }
    } catch (error) {
      this.fail(asError(error));
    } finally {
      this.receiving = false;
      if (this.stopped) this.pendingBytes = 0;
    }
  }

  private async consume(frame: OrganizationNativeFrame): Promise<void> {
    const signal = this.receiverAbort.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        this.input.receive(frame, signal),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("organisation receiver stopped"));
          signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => reject(new Error("organisation receiver timed out")), 5000);
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  private fence(error: Error): void {
    this.stopped = true;
    this.receiverAbort.abort();
    this.incoming.length = 0;
    // An in-flight receiver can still finish after fencing; its byte accounting must not go negative.
    if (!this.receiving) this.pendingBytes = 0;
    for (const abort of this.writes) abort(error);
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.failure = error;
    this.fence(error);
    this.child?.kill("SIGKILL");
    this.input.failed(error);
  }
}
