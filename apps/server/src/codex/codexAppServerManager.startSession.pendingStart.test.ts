import { rmSync } from "node:fs";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexAppServerManager } from "./codexAppServerManager.ts";
import {
  createFakeCodexBinaries,
  delay,
  localStartInput,
  remoteStartInput,
  watchEventLoop,
} from "./codexAppServerManager.pendingStart.fixtures.ts";

const binaries = createFakeCodexBinaries();
afterAll(() => binaries.cleanup());

function createManager() {
  const manager = new CodexAppServerManager();
  const methods: string[] = [];
  manager.on("event", (event) => methods.push(event.method));
  return { manager, methods };
}

describe.skipIf(process.platform === "win32")(
  "Codex remote start with a pending version check",
  () => {
    let originalPath: string | undefined;
    beforeEach(() => {
      originalPath = process.env.PATH;
      process.env.PATH = `${binaries.directory}:${originalPath ?? ""}`;
    });
    afterEach(() => {
      process.env.PATH = originalPath;
    });

    it("starts a remote session without blocking the event loop during a slow version check", async () => {
      binaries.installFakeSsh(1.5);
      const { manager } = createManager();
      const loop = watchEventLoop();
      const startedAt = performance.now();
      try {
        await expect(
          manager.startSession(remoteStartInput("thread-remote-ok")),
        ).resolves.toMatchObject({
          status: "ready",
          resumeCursor: { threadId: "provider-thread" },
        });
      } finally {
        const maxGapMs = loop.stop();
        expect(maxGapMs).toBeLessThan(250);
      }
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1_400);
      expect(binaries.remoteAppServerSpawned()).toBe(true);
      expect(manager.hasSession(remoteStartInput("thread-remote-ok").threadId)).toBe(true);
      manager.stopAll();
    }, 20_000);

    it("never spawns the remote app-server when stopSession lands during the version check", async () => {
      binaries.installFakeSsh(1);
      const { manager, methods } = createManager();
      const input = remoteStartInput("thread-remote-stop");
      const startup = manager.startSession(input);
      await delay(200);
      expect(manager.hasSession(input.threadId)).toBe(false);

      manager.stopSession(input.threadId);

      await expect(startup).rejects.toThrow(/stopped before its app-server process started/);
      await delay(300);
      expect(binaries.remoteAppServerSpawned()).toBe(false);
      expect(manager.hasSession(input.threadId)).toBe(false);
      expect(manager.listSessions()).toEqual([]);
      expect(methods).toEqual(["session/startFailed"]);
    }, 20_000);

    it("never spawns the remote app-server when stopAll lands during the version check", async () => {
      binaries.installFakeSsh(1);
      const { manager } = createManager();
      const first = remoteStartInput("thread-remote-quit-a");
      const second = remoteStartInput("thread-remote-quit-b");
      const startups = [manager.startSession(first), manager.startSession(second)];
      await delay(200);

      manager.stopAll();

      await Promise.all(
        startups.map((startup) =>
          expect(startup).rejects.toThrow(/stopped before its app-server process started/),
        ),
      );
      await delay(300);
      expect(binaries.remoteAppServerSpawned()).toBe(false);
      expect(manager.listSessions()).toEqual([]);
    }, 20_000);

    it("leaves a later start for the same thread unaffected by an earlier cancel", async () => {
      binaries.installFakeSsh(0.5);
      const { manager } = createManager();
      const cancelled = manager.startSession(remoteStartInput("thread-remote-retry"));
      await delay(100);
      manager.stopSession(remoteStartInput("thread-remote-retry").threadId);
      await expect(cancelled).rejects.toThrow(/stopped before/);

      await expect(
        manager.startSession(remoteStartInput("thread-remote-retry")),
      ).resolves.toMatchObject({ status: "ready" });
      expect(binaries.remoteAppServerSpawned()).toBe(true);
      manager.stopAll();
    }, 20_000);
  },
);

describe.skipIf(process.platform === "win32")("Codex local start", () => {
  it("keeps the local start, readiness and stop behaviour unchanged", async () => {
    const { manager, methods } = createManager();
    const input = localStartInput("thread-local", binaries.localCodexPath(), binaries.directory);

    await expect(manager.startSession(input)).resolves.toMatchObject({
      status: "ready",
      cwd: binaries.directory,
      resumeCursor: { threadId: "provider-thread" },
    });
    expect(methods).toEqual([
      "session/connecting",
      "session/threadOpenRequested",
      "session/threadOpenResolved",
      "session/ready",
    ]);
    expect(manager.hasSession(input.threadId)).toBe(true);

    manager.stopSession(input.threadId);
    expect(manager.hasSession(input.threadId)).toBe(false);
    expect(methods.at(-1)).toBe("session/closed");
  }, 20_000);

  it("fails a start cleanly when the app-server spawn errors, without an uncaught exception", async () => {
    const { manager } = createManager();
    const binaryPath = binaries.localCodexPath();
    const first = localStartInput("thread-local-moved", binaryPath, binaries.directory);
    await expect(manager.startSession(first)).resolves.toMatchObject({ status: "ready" });
    manager.stopAll();
    rmSync(binaryPath);

    // From a macrotask, Node delivers the spawn error before any await resumes.
    const startup = await new Promise<{ readonly result: Promise<unknown> }>((resolve) =>
      setTimeout(() => resolve({ result: manager.startSession(first) }), 0),
    );
    await expect(startup.result).rejects.toThrow(/ENOENT/);
    expect(manager.hasSession(first.threadId)).toBe(false);
  }, 20_000);

  it("still rejects an unsupported local Codex CLI before registering a session", async () => {
    const { manager, methods } = createManager();
    const input = localStartInput(
      "thread-local-old",
      binaries.localCodexPath("0.1.0"),
      binaries.directory,
    );

    await expect(manager.startSession(input)).rejects.toThrow(/too old for bigbud/);
    expect(manager.hasSession(input.threadId)).toBe(false);
    expect(methods).toEqual(["session/startFailed"]);
  }, 20_000);
});
