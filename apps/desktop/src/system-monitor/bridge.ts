import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Writable, Readable } from "node:stream";
import * as FS from "node:fs";
import * as Path from "node:path";
import type { WebContents } from "electron";
import type {
  MonitorDemand,
  MonitorEvent,
  MonitorProcessPage,
  MonitorProcessQuery,
  MonitorSnapshot,
  MonitorProcessRoot,
} from "@bigbud/contracts/system-monitor/types";
import { resolvePackagedDesktopSupervisorBinary } from "../env/pathResolver";
import { decodeEvent, encodeCommand, frameBytes, MAX_FRAME_BYTES } from "./wire";

const HANDSHAKE_MS = 3_000;
const REQUEST_MS = 3_000;
const MAX_IN_FLIGHT = 16;

type Command = Parameters<typeof encodeCommand>[0];
type Request = {
  resolve: (value: MonitorEvent) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class SystemMonitorBridge {
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, Request>();
  private nextRequestId = 1;
  private activeQueries = 0;
  private connecting: Promise<void> | null = null;
  private ready = false;
  private appResourcesSupported = false;
  private closing = false;
  private subscribers = new Set<WebContents>();
  private snapshotWaiters = new Map<
    number,
    { resolve: (snapshot: MonitorSnapshot) => void; reject: (error: Error) => void }
  >();
  private earlySnapshots = new Map<number, MonitorSnapshot>();

  constructor(
    private readonly packaged: boolean,
    private readonly getRoots: (
      child: ChildProcessByStdio<Writable, Readable, null> | null,
    ) => MonitorProcessRoot[] = () => [],
  ) {}

  addRenderer(sender: WebContents): void {
    if (this.subscribers.has(sender)) return;
    this.subscribers.add(sender);
    sender.once("destroyed", () => this.subscribers.delete(sender));
  }
  private emit(event: MonitorEvent): void {
    for (const sender of this.subscribers) {
      if (!sender.isDestroyed()) sender.send("desktop:system-monitor-event", event);
    }
  }
  private resolveBinary(): string {
    if (process.env.BIGBUD_SYSTEM_MONITOR_ENABLED === "0") throw new Error("monitor disabled");
    const path = this.packaged
      ? resolvePackagedDesktopSupervisorBinary()
      : process.env.BIGBUD_SYSTEM_MONITOR_BINARY;
    if (!path || !Path.isAbsolute(path)) throw new Error("monitor binary unavailable");
    const stat = FS.statSync(path);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o111) === 0))
      throw new Error("monitor binary unavailable");
    return path;
  }
  private async connect(): Promise<void> {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.start().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  private async start(): Promise<void> {
    const path = this.resolveBinary();
    const child = spawn(path, ["--system-monitor"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child === child) this.onData(chunk);
    });
    child.on("error", () => {
      if (this.child === child) this.fail("monitor process failed");
    });
    child.on("exit", () => {
      if (this.child === child) this.fail("monitor process exited");
    });
    let event: MonitorEvent;
    try {
      event = await this.request({ type: "hello" }, 0, HANDSHAKE_MS);
    } catch (error) {
      this.fail("monitor handshake failed");
      throw error;
    }
    if (
      event.type !== "helloAck" ||
      event.major !== 1 ||
      event.minor < 2 ||
      event.maximumFrameBytes !== MAX_FRAME_BYTES
    ) {
      this.fail("monitor protocol mismatch");
      throw new Error("monitor protocol mismatch");
    }
    this.ready = true;
    this.appResourcesSupported = event.minor >= 3 && event.capabilities.includes("app-resources");
    this.emit(event);
  }
  private onData(chunk: Buffer): void {
    if (this.buffer.length + chunk.length > MAX_FRAME_BYTES * 2) {
      this.fail("monitor output overflow");
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.fail("invalid monitor frame length");
        return;
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      try {
        this.onEvent(decodeEvent(payload));
      } catch {
        this.fail("invalid monitor frame");
        return;
      }
    }
  }
  private onEvent(event: MonitorEvent): void {
    if (event.type === "snapshot") {
      const waiter = this.snapshotWaiters.get(event.snapshot.subscriptionId);
      if (waiter) waiter.resolve(event.snapshot);
      else {
        this.earlySnapshots.delete(event.snapshot.subscriptionId);
        this.earlySnapshots.set(event.snapshot.subscriptionId, event.snapshot);
        if (this.earlySnapshots.size > MAX_IN_FLIGHT) {
          this.earlySnapshots.delete(this.earlySnapshots.keys().next().value!);
        }
      }
    }
    const id =
      event.type === "subscribeAck" || event.type === "retryAck"
        ? event.requestId
        : event.type === "processPage"
          ? event.page.requestId
          : event.type === "error"
            ? event.error.requestId
            : event.type === "helloAck"
              ? 0
              : -1;
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      if (event.type === "error") pending.reject(new Error(event.error.code));
      else pending.resolve(event);
    }
    if (event.type !== "subscribeAck" && event.type !== "retryAck") this.emit(event);
  }
  private request(
    command: Command,
    requestId: number,
    timeoutMs = REQUEST_MS,
  ): Promise<MonitorEvent> {
    if (
      !this.child?.stdin.writable ||
      this.child.stdin.writableLength > MAX_FRAME_BYTES ||
      this.pending.size >= MAX_IN_FLIGHT
    )
      return Promise.reject(new Error("monitor unavailable or busy"));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("monitor request timeout"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        this.child!.stdin.write(frameBytes(encodeCommand(command)));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error as Error);
      }
    });
  }
  private send(command: Command): void {
    if (!this.ready || !this.child?.stdin.writable) throw new Error("monitor unavailable");
    if (this.child.stdin.writableLength > MAX_FRAME_BYTES) throw new Error("monitor input busy");
    this.child.stdin.write(frameBytes(encodeCommand(command)));
  }
  private nextId(): number {
    return this.nextRequestId++;
  }
  async subscribe(demand: MonitorDemand): Promise<number> {
    await this.connect();
    const requestId = this.nextId();
    const roots = this.appRoots(demand);
    const event = await this.request({ type: "subscribe", requestId, demand, roots }, requestId);
    if (event.type !== "subscribeAck") throw new Error("monitor subscribe failed");
    return event.subscriptionId;
  }
  async readSnapshot(): Promise<MonitorSnapshot> {
    const subscriptionId = await this.subscribe({ processes: false, disks: false, sensors: false });
    try {
      const early = this.earlySnapshots.get(subscriptionId);
      if (early) {
        this.ack(subscriptionId, early.epoch, early.sequence);
        return early;
      }
      const snapshot = await new Promise<MonitorSnapshot>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.snapshotWaiters.delete(subscriptionId);
          reject(new Error("monitor snapshot timeout"));
        }, 3_000);
        this.snapshotWaiters.set(subscriptionId, {
          resolve: (value) => {
            clearTimeout(timeout);
            this.snapshotWaiters.delete(subscriptionId);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            this.snapshotWaiters.delete(subscriptionId);
            reject(error);
          },
        });
      });
      this.ack(subscriptionId, snapshot.epoch, snapshot.sequence);
      return snapshot;
    } finally {
      this.snapshotWaiters.delete(subscriptionId);
      this.earlySnapshots.delete(subscriptionId);
      try {
        this.unsubscribe(subscriptionId);
      } catch {
        // A disconnected child has already released its subscriptions.
      }
    }
  }
  update(subscriptionId: number, demand: MonitorDemand): void {
    this.send({ type: "update", subscriptionId, demand, roots: this.appRoots(demand) });
  }
  private appRoots(demand: MonitorDemand): MonitorProcessRoot[] {
    if (!demand.appResources) return [];
    if (!this.appResourcesSupported)
      throw new Error(
        "bigbud monitoring requires monitor protocol 1.3; rebuild the desktop supervisor",
      );
    return this.getRoots(this.child);
  }
  unsubscribe(subscriptionId: number): void {
    this.earlySnapshots.delete(subscriptionId);
    this.send({ type: "unsubscribe", subscriptionId });
  }
  ack(subscriptionId: number, epoch: number, sequence: number): void {
    this.send({ type: "ack", subscriptionId, epoch, sequence });
  }
  async query(query: MonitorProcessQuery): Promise<MonitorProcessPage> {
    if (this.activeQueries >= 2) throw new Error("monitor query busy");
    this.activeQueries += 1;
    try {
      await this.connect();
      const requestId = this.nextId();
      const event = await this.request({ type: "query", requestId, query }, requestId);
      if (event.type !== "processPage") throw new Error("monitor query failed");
      return event.page;
    } finally {
      this.activeQueries -= 1;
    }
  }
  async retry(): Promise<boolean> {
    if (!this.ready) {
      await this.connect();
      return true;
    }
    const requestId = this.nextId();
    const event = await this.request({ type: "retry", requestId }, requestId);
    if (event.type !== "retryAck") throw new Error("monitor retry failed");
    return true;
  }
  private fail(reason: string): void {
    if (!this.child && !this.connecting) return;
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    for (const waiter of this.snapshotWaiters.values()) waiter.reject(new Error(reason));
    this.snapshotWaiters.clear();
    this.earlySnapshots.clear();
    if (child && !child.killed) child.kill();
    if (!this.closing) this.emit({ type: "unavailable", reason });
  }
  stop(): void {
    this.closing = true;
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) {
      if (child.stdin.writable) {
        try {
          child.stdin.write(frameBytes(encodeCommand({ type: "shutdown" })));
          child.stdin.end();
        } catch {
          child.kill();
        }
      }
      const fallback = setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill();
      }, 2_000);
      fallback.unref();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("monitor stopped"));
    }
    this.pending.clear();
    for (const waiter of this.snapshotWaiters.values()) waiter.reject(new Error("monitor stopped"));
    this.snapshotWaiters.clear();
    this.earlySnapshots.clear();
    this.subscribers.clear();
  }
}
