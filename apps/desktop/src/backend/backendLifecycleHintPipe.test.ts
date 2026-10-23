import * as ChildProcess from "node:child_process";
import { PassThrough } from "node:stream";

import type { DesktopLifecycleHint } from "@bigbud/contracts/server/desktopLifecycleHint.ts";
import { describe, expect, it, vi } from "vitest";

import {
  attachBackendLifecycleHintPipe,
  BackendLifecycleHintPipe,
  detachBackendLifecycleHintPipe,
  writeBackendLifecycleHint,
  type LifecycleHintStream,
} from "./backendLifecycleHintPipe";

/** Mirrors the contract schema: exactly these four keys, with these types. */
function decodeHint(value: unknown): DesktopLifecycleHint {
  const hint = value as DesktopLifecycleHint;
  expect(Object.keys(hint).toSorted()).toEqual(["kind", "occurredAt", "online", "sequence"]);
  expect(["suspend", "resume", "online", "offline"]).toContain(hint.kind);
  expect(Number.isInteger(hint.sequence) && hint.sequence >= 0).toBe(true);
  expect(typeof hint.occurredAt).toBe("number");
  expect(hint.online === null || typeof hint.online === "boolean").toBe(true);
  return hint;
}

function capture(stream: PassThrough): string[] {
  const lines: string[] = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => lines.push(...chunk.split("\n").filter(Boolean)));
  return lines;
}

/** A stream that looks like a Node pipe socket with a native fd. */
function fakePipeSocket(writableLength = 0) {
  const stream = new PassThrough() as PassThrough & { _handle?: { fd: number } };
  stream._handle = { fd: 42 };
  Object.defineProperty(stream, "writableLength", { get: () => writableLength });
  return stream;
}

describe("backend lifecycle hint pipe", () => {
  it("writes contract-valid JSON lines with a per-backend sequence", () => {
    const stream = new PassThrough();
    const lines = capture(stream);
    const pipe = new BackendLifecycleHintPipe(stream, { platform: "darwin", log: vi.fn() });

    pipe.write({ kind: "suspend", occurredAt: 1, online: true });
    pipe.write({ kind: "resume", occurredAt: 2, online: null });

    expect(lines.map((line) => decodeHint(JSON.parse(line)))).toEqual([
      { kind: "suspend", sequence: 1, occurredAt: 1, online: true },
      { kind: "resume", sequence: 2, occurredAt: 2, online: null },
    ]);
    const next = new BackendLifecycleHintPipe(new PassThrough(), {
      platform: "darwin",
      log: vi.fn(),
    });
    const nextLines = capture((next as unknown as { stream: PassThrough }).stream);
    next.write({ kind: "online", occurredAt: 3, online: true });
    expect(JSON.parse(nextLines[0]!).sequence).toBe(1);
  });

  it("writes a Linux suspend synchronously to the native fd", () => {
    const stream = fakePipeSocket();
    const queued = capture(stream);
    const writeSync = vi.fn();
    const pipe = new BackendLifecycleHintPipe(stream, {
      platform: "linux",
      log: vi.fn(),
      writeSync,
    });

    pipe.write({ kind: "suspend", occurredAt: 5, online: true });
    expect(writeSync).toHaveBeenCalledWith(42, expect.stringContaining('"kind":"suspend"'));
    expect(queued).toEqual([]);

    pipe.write({ kind: "resume", occurredAt: 6, online: true });
    expect(writeSync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(queued[0]!)).toMatchObject({ kind: "resume", sequence: 2 });
  });

  it("queues the Linux suspend when output is pending or the sync write fails", () => {
    const pending = fakePipeSocket(10);
    const pendingLines = capture(pending);
    const writeSync = vi.fn();
    new BackendLifecycleHintPipe(pending, { platform: "linux", log: vi.fn(), writeSync }).write({
      kind: "suspend",
      occurredAt: 1,
      online: null,
    });
    expect(writeSync).not.toHaveBeenCalled();
    expect(pendingLines).toHaveLength(1);

    const full = fakePipeSocket();
    const fullLines = capture(full);
    const log = vi.fn();
    new BackendLifecycleHintPipe(full, {
      platform: "linux",
      log,
      writeSync: () => {
        throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
      },
    }).write({ kind: "suspend", occurredAt: 1, online: null });
    expect(fullLines).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("hint_fd5_sync_write_failed", expect.any(String));
  });

  it("stops writing once the backend's pipe closed", () => {
    const stream = new PassThrough();
    const pipe = new BackendLifecycleHintPipe(stream, { platform: "darwin", log: vi.fn() });
    stream.emit("close");
    expect(pipe.write({ kind: "resume", occurredAt: 1, online: true })).toBe(false);
  });

  it("routes hints to the newest backend and ignores a stale detach", () => {
    const first = new PassThrough();
    const second = new PassThrough();
    const deps = { platform: "darwin" as const, log: vi.fn() };
    const firstPipe = attachBackendLifecycleHintPipe(first, deps);
    const secondPipe = attachBackendLifecycleHintPipe(second, deps);
    const secondLines = capture(second);

    detachBackendLifecycleHintPipe(firstPipe);
    expect(writeBackendLifecycleHint({ kind: "online", occurredAt: 1, online: true })).toBe(true);
    expect(secondLines).toHaveLength(1);

    detachBackendLifecycleHintPipe(secondPipe);
    expect(writeBackendLifecycleHint({ kind: "online", occurredAt: 2, online: true })).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "delivers a synchronous suspend line through a real child fd 5 pipe",
    async () => {
      const child = ChildProcess.spawn(
        process.execPath,
        [
          "-e",
          "require('fs').createReadStream(null,{fd:5}).on('data',d=>{process.stdout.write(d);process.exit(0)})",
        ],
        { stdio: ["ignore", "pipe", "inherit", "ignore", "ignore", "pipe"] },
      );
      const output = new Promise<string>((resolve) => {
        let text = "";
        child.stdout!.on("data", (chunk) => (text += String(chunk)));
        child.on("close", () => resolve(text));
      });
      const log = vi.fn();
      const hintStream = (child.stdio as ReadonlyArray<unknown>)[5] as LifecycleHintStream;
      const pipe = new BackendLifecycleHintPipe(hintStream, {
        platform: "linux",
        log,
      });
      expect(pipe.write({ kind: "suspend", occurredAt: 7, online: true })).toBe(true);
      expect(log).not.toHaveBeenCalled();
      expect(decodeHint(JSON.parse((await output).trim()))).toMatchObject({
        kind: "suspend",
        sequence: 1,
      });
    },
  );
});
