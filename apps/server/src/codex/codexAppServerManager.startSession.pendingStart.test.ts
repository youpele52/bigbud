import { rmSync } from "node:fs";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexAppServerManager } from "./codexAppServerManager.ts";
import {
  createFakeCodexBinaries,
  delay,
  localStartInput,
  remoteStartInput,
} from "./codexAppServerManager.pendingStart.fixtures.ts";

const binaries = createFakeCodexBinaries();
afterAll(() => binaries.cleanup());

function createManager() {
  const manager = new CodexAppServerManager();
  const methods: string[] = [];
  manager.on("event", (event) => methods.push(event.method));
  return { manager, methods };
}

describe.skipIf(process.platform === "win32")("Codex remote start without the SSH owner", () => {
  let originalPath: string | undefined;
  beforeEach(() => {
    originalPath = process.env.PATH;
    process.env.PATH = `${binaries.directory}:${originalPath ?? ""}`;
  });
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  // W7: remote Codex runs only through the Rust SSH owner. The legacy TypeScript `ssh`
  // version-check/spawn path (and its pending-start cancellation tests) was deleted.
  it("refuses a remote start without the SSH owner and never spawns ssh", async () => {
    binaries.installFakeSsh(0);
    const { manager } = createManager();
    const input = remoteStartInput("thread-remote-owner-required");
    await expect(manager.startSession(input)).rejects.toThrow(/SSH owner is unavailable/);
    await delay(100);
    expect(binaries.remoteAppServerSpawned()).toBe(false);
    expect(manager.hasSession(input.threadId)).toBe(false);
    expect(manager.listSessions()).toEqual([]);
  }, 20_000);
});

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

  it("rechecks a removed binary on future starts instead of trusting a path-only version cache", async () => {
    const { manager } = createManager();
    const binaryPath = binaries.localCodexPath();
    const first = localStartInput("thread-local-moved", binaryPath, binaries.directory);
    await expect(manager.startSession(first)).resolves.toMatchObject({ status: "ready" });
    manager.stopAll();
    rmSync(binaryPath);

    // A fresh preflight rejects the changed binary before an app-server can be spawned.
    const startup = await new Promise<{ readonly result: Promise<unknown> }>((resolve) =>
      setTimeout(() => resolve({ result: manager.startSession(first) }), 0),
    );
    await expect(startup.result).rejects.toThrow(/not installed or not executable/);
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
