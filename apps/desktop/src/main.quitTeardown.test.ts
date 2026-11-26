import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { DesktopQuitReason } from "@bigbud/contracts/server/desktopLifecycleHint.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendLifecycleHintPipe } from "./backend/backendLifecycleHintPipe";
import { createAppQuitActions } from "./main.appQuitActions";
import {
  createDesktopQuitTeardown,
  QUIT_HINT_ACK_TIMEOUT_MS,
  registerQuitTeardownAppHandlers,
  registerQuitTeardownPowerMonitor,
  withQuitIntentReason,
} from "./main.quitTeardown";

/** An Electron-like app: `quit()` emits `before-quit` synchronously, as Electron does. */
function harness(options: { readonly withBackend?: boolean } = {}) {
  const calls: string[] = [];
  const stream = new PassThrough();
  const lines: Array<Record<string, unknown>> = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    for (const line of chunk.split("\n").filter(Boolean)) lines.push(JSON.parse(line));
  });
  const pipe = new BackendLifecycleHintPipe(stream, { platform: "darwin", log: vi.fn() });
  const app = new EventEmitter() as EventEmitter & { quit: () => void };
  let exited = false;
  app.quit = () => {
    calls.push("app.quit");
    let prevented = false;
    app.emit("before-quit", { preventDefault: () => (prevented = true) });
    calls.push(prevented ? "before-quit:prevented" : "before-quit:proceeded");
    if (!prevented) exited = true;
  };
  const sendQuitHint = vi.fn((reason: DesktopQuitReason) => {
    if (options.withBackend === false) return null;
    const sequence = pipe.writeQuit(reason, 1_000);
    return sequence === null
      ? null
      : { sequence, acknowledged: (timeoutMs: number) => pipe.waitForAck(sequence, timeoutMs) };
  });
  const teardown = createDesktopQuitTeardown({
    appInstance: app,
    log: vi.fn(),
    markQuitting: () => calls.push("markQuitting"),
    stopRuntime: () => calls.push("stopRuntime"),
    sendQuitHint,
  });
  registerQuitTeardownAppHandlers(app as never, teardown, "darwin");
  return { app, calls, lines, pipe, sendQuitHint, teardown, isExited: () => exited };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop quit handshake", () => {
  it("prevents the first before-quit, then quits once more and tears down once", async () => {
    const h = harness();
    h.app.quit();
    expect(h.calls).toEqual(["app.quit", "before-quit:prevented"]);
    expect(h.teardown.getHandshakeState()).toBe("pending");
    expect(h.lines).toEqual([
      { kind: "quit", sequence: 1, occurredAt: 1_000, online: null, reason: "quit" },
    ]);

    h.pipe.acknowledge(1);
    await flush();
    expect(h.calls).toEqual([
      "app.quit",
      "before-quit:prevented",
      "app.quit",
      "markQuitting",
      "stopRuntime",
      "before-quit:proceeded",
    ]);
    expect(h.isExited()).toBe(true);
    expect(h.sendQuitHint).toHaveBeenCalledTimes(1);
  });

  it("ignores a second quit request while the handshake is pending", async () => {
    const h = harness();
    h.app.quit();
    h.app.quit();
    expect(h.calls).toEqual([
      "app.quit",
      "before-quit:prevented",
      "app.quit",
      "before-quit:prevented",
    ]);
    expect(h.sendQuitHint).toHaveBeenCalledTimes(1);
    h.pipe.acknowledge(1);
    await flush();
    expect(h.calls.filter((call) => call === "app.quit")).toHaveLength(3);
    expect(h.calls.filter((call) => call === "stopRuntime")).toHaveLength(1);
  });

  it("still quits when the ack does not arrive within 1,500 ms", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.app.quit();
    await vi.advanceTimersByTimeAsync(QUIT_HINT_ACK_TIMEOUT_MS - 1);
    expect(h.calls).not.toContain("stopRuntime");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls.slice(2)).toEqual([
      "app.quit",
      "markQuitting",
      "stopRuntime",
      "before-quit:proceeded",
    ]);
  });

  it("quits at once when the backend exits during the handshake", async () => {
    const h = harness();
    h.app.quit();
    (h.pipe as unknown as { close: () => void }).close();
    await flush();
    expect(h.isExited()).toBe(true);
  });

  it("tears down without preventing when no backend can hear the hint", () => {
    const h = harness({ withBackend: false });
    h.app.quit();
    expect(h.calls).toEqual(["app.quit", "markQuitting", "stopRuntime", "before-quit:proceeded"]);
  });

  it("F7: the update path runs the handshake first, so the next before-quit is not prevented", async () => {
    const h = harness();
    const handshake = h.teardown.runHandshake("update");
    expect(h.lines).toEqual([
      { kind: "quit", sequence: 1, occurredAt: 1_000, online: null, reason: "update" },
    ]);
    h.pipe.acknowledge(1);
    await handshake;
    expect(h.teardown.getHandshakeState()).toBe("done");
    expect(h.calls).toEqual([]);

    // quitAndInstall: `before-quit-for-update` tears down, then `before-quit` must proceed.
    h.teardown.prepareForAppQuit("before-quit-for-update");
    h.app.quit();
    expect(h.calls).toEqual(["markQuitting", "stopRuntime", "app.quit", "before-quit:proceeded"]);
    expect(h.sendQuitHint).toHaveBeenCalledTimes(1);
  });

  it("announces restart for Restart and quit for Quit", async () => {
    const h = harness();
    const actions = withQuitIntentReason(
      createAppQuitActions({
        appInstance: { ...h.app, exit: vi.fn(), once: vi.fn(), relaunch: vi.fn() } as never,
        isDevelopment: false,
        prepareForAppQuit: vi.fn(),
      }),
      h.teardown,
    );
    actions.restart("settings-restart");
    expect(h.lines[0]).toMatchObject({ kind: "quit", reason: "restart" });
  });
});

describe("OS shutdown and logout", () => {
  it("powerMonitor shutdown quits with no hint and no wait", () => {
    const h = harness();
    const monitor = new EventEmitter();
    registerQuitTeardownPowerMonitor(monitor as never, h.teardown);
    monitor.emit("shutdown");
    expect(h.sendQuitHint).not.toHaveBeenCalled();
    expect(h.calls).toEqual(["markQuitting", "stopRuntime", "app.quit", "before-quit:proceeded"]);
    expect(h.lines).toEqual([]);
  });

  it("Windows session-end quits with no hint and no wait, even during a pending handshake", async () => {
    const calls: string[] = [];
    const app = new EventEmitter() as EventEmitter & { quit: () => void };
    app.quit = () => calls.push("app.quit");
    const teardown = createDesktopQuitTeardown({
      appInstance: app,
      log: vi.fn(),
      markQuitting: vi.fn(),
      stopRuntime: () => calls.push("stopRuntime"),
      sendQuitHint: () => ({ sequence: 1, acknowledged: () => new Promise(() => undefined) }),
    });
    registerQuitTeardownAppHandlers(app as never, teardown, "win32");
    const window = new EventEmitter();
    app.emit("browser-window-created", {}, window);

    app.emit("before-quit", { preventDefault: () => calls.push("prevented") });
    expect(teardown.getHandshakeState()).toBe("pending");
    window.emit("session-end", {});
    expect(calls).toEqual(["prevented", "stopRuntime", "app.quit"]);
    await flush();
    expect(calls).toEqual(["prevented", "stopRuntime", "app.quit"]);
  });

  it("does not register session-end outside Windows", () => {
    const h = harness();
    const window = new EventEmitter();
    h.app.emit("browser-window-created", {}, window);
    expect(window.listenerCount("session-end")).toBe(0);
  });
});
