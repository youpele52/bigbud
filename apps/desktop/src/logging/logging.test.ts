import { EventEmitter } from "node:events";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getVersion: () => "1.2.3", isPackaged: true } }));

import {
  captureBackendOutput,
  initializePackagedLogging,
  QueuedLogSink,
  resolveDesktopLogDir,
  sanitizeLogValue,
  writeBackendLifecycleEvent,
} from "./logging";

const tempRoots: string[] = [];

function makeTempDir(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-desktop-log-"));
  tempRoots.push(directory);
  return directory;
}

async function flushQueue(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

afterEach(() => {
  for (const directory of tempRoots.splice(0)) {
    FS.rmSync(directory, { force: true, recursive: true });
  }
});

describe("desktop packaged logging", () => {
  it("places logs beneath Electron userData", () => {
    expect(resolveDesktopLogDir("/app-data/bigbud")).toBe(Path.join("/app-data/bigbud", "logs"));
  });

  it("uses the supplied app-data log directory with bounded rotating files", async () => {
    const logDirectory = makeTempDir();
    const result = initializePackagedLogging(logDirectory, 32, 2, "run-id");
    result.desktopLogSink?.write("x".repeat(33));
    result.desktopLogSink?.flush();
    result.desktopLogSink?.write("y");
    result.desktopLogSink?.flush();

    expect(FS.existsSync(Path.join(logDirectory, "desktop-main.log"))).toBe(true);
    expect(FS.existsSync(Path.join(logDirectory, "desktop-main.log.1"))).toBe(true);
    expect(FS.existsSync(Path.join(logDirectory, "server-child.log"))).toBe(false);
    await flushQueue();
  });

  it("redacts local lifecycle and child output while retaining useful stderr", async () => {
    const chunks: string[] = [];
    const sink = new QueuedLogSink({ write: (chunk) => chunks.push(String(chunk)) });
    const stderr = new EventEmitter();
    const child = {
      stdout: new EventEmitter(),
      stderr,
    } as unknown as import("node:child_process").ChildProcess;
    captureBackendOutput(child, sink);
    stderr.emit(
      "data",
      "fatal token=raw-auth API_KEY=raw-key https://user:password@example.test bootstrapToken=bootstrap-secret",
    );
    writeBackendLifecycleEvent(
      "child_exit",
      "stderr=Authorization: Bearer raw-secret",
      sink,
      "run",
    );
    await flushQueue();

    const output = chunks.join("");
    expect(output).toContain("fatal");
    expect(output).toContain("event=child_exit");
    expect(output).not.toContain("raw-auth");
    expect(output).not.toContain("raw-key");
    expect(output).not.toContain("user:password");
    expect(output).not.toContain("bootstrap-secret");
  });

  it("swallows queued write failures", async () => {
    const write = vi.fn(() => {
      throw new Error("disk unavailable");
    });
    const sink = new QueuedLogSink({ write });

    expect(() => sink.write("backend restart attempt=1")).not.toThrow();
    await flushQueue();
    expect(write).toHaveBeenCalledOnce();
    expect(sanitizeLogValue("token=raw-secret")).not.toContain("raw-secret");
  });
});
