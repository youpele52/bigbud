import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  open: vi.fn(),
  getPath: vi.fn(() => "/diagnostics/profile"),
}));
vi.mock("electron", () => ({
  app: { getPath: mocks.getPath, getVersion: () => "test-version", getAppPath: () => "/app" },
}));
vi.mock("@bigbud/shared/logging", () => ({
  RotatingFileSink: class {
    write = mocks.write;
    constructor(options: unknown) {
      mocks.open(options);
    }
  },
}));
vi.mock("../logging/logging", () => ({
  resolveDesktopLogDir: (path: string) => `${path}/logs`,
  QueuedLogSink: class {
    write = mocks.write;
  },
}));

async function setup(enabled = true) {
  if (enabled) vi.stubEnv("BIGBUD_BROWSER_GESTURE_DIAGNOSTICS", "1");
  const { createBrowserGestureDiagnostics } = await import("./browserHistoryGestures.diagnostics");
  const host = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const owner = { id: 1, isFocused: () => true, webContents: host };
  const contents = Object.assign(new EventEmitter(), {
    id: 2,
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: vi.fn(async () => [
      { event: "wheel", details: { deltaX: 12 } },
    ]),
  });
  const record = createBrowserGestureDiagnostics(
    owner as unknown as BrowserWindow,
    contents as unknown as WebContents,
    "source-v1",
  );
  const entries = () => mocks.write.mock.calls.map(([line]) => JSON.parse(line as string));
  return { host, contents, record, entries };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("BIGBUD_BROWSER_GESTURE_DIAGNOSTICS", "");
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("opt-in physical browser gesture diagnostics", () => {
  it("does not access app paths, open logs or attach listeners by default", async () => {
    const { record, host } = await setup(false);
    expect(record).toBeUndefined();
    expect(mocks.getPath).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(host.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records runtime identity, host scroll transport and private page samples without key values", async () => {
    const { host, contents, entries } = await setup();
    host.emit("input-event", {}, { type: "rawKeyDown", key: "secret" });
    host.emit("input-event", {}, { type: "mouseWheel", deltaX: 12 });
    await vi.advanceTimersByTimeAsync(200);
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1004, [
      { code: "globalThis.__bigbudHistoryGestures?.drainDiagnostics() ?? []" },
    ]);
    expect(entries()[0]).toMatchObject({
      event: "runtime",
      pid: process.pid,
      version: "test-version",
      maxRecords: 1200,
    });
    expect(entries()[0].sourceHash).toMatch(/^[0-9a-f]{16}$/);
    expect(entries()).toContainEqual(
      expect.objectContaining({ event: "host-input", details: { type: "mouseWheel" } }),
    );
    expect(entries()).toContainEqual(expect.objectContaining({ event: "page" }));
    expect(JSON.stringify(entries())).not.toContain("secret");
    contents.emit("destroyed");
    expect(host.listenerCount("input-event")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps records and removes polling and listeners when the budget is consumed", async () => {
    const { host, record, entries } = await setup();
    for (let i = 0; i < 2000; i += 1) record?.("sample");
    expect(entries()).toHaveLength(1201); // One runtime header plus the bounded event budget.
    await vi.advanceTimersByTimeAsync(200);
    expect(host.listenerCount("input-event")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires after two minutes even when no input is received", async () => {
    const { host, record, entries } = await setup();
    await vi.advanceTimersByTimeAsync(120_000);
    const length = entries().length;
    record?.("late");
    expect(entries()).toHaveLength(length);
    expect(host.listenerCount("input-event")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not block gesture binding if diagnostic initialization fails", async () => {
    mocks.open.mockImplementationOnce(() => {
      throw new Error("read-only");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { record } = await setup();
    expect(record).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
