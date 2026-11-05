import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));
import { desktopIpcChannels } from "../main.channels";
import { registerSystemMonitorIpc } from "./ipc";
import { configureIpcAuthorization } from "../window/ipcAuthorization";

/** Every fake sender below is a registered main renderer with a live main frame. */
const frames = new WeakMap<object, object>();
const ev = (sender: object) => {
  if (!frames.has(sender)) frames.set(sender, {});
  Object.assign(sender, { mainFrame: frames.get(sender) });
  return { sender, senderFrame: frames.get(sender) };
};

describe("system monitor IPC authorization", () => {
  beforeEach(() => {
    handlers.clear();
    configureIpcAuthorization({ getRole: () => "main" });
  });
  it("allows app demand but never accepts renderer ownership roots", async () => {
    const bridge = { subscribe: vi.fn(async () => 7), addRenderer: vi.fn() };
    registerSystemMonitorIpc(bridge as never, () => true);
    const handler = handlers.get(desktopIpcChannels.systemMonitorSubscribe)!;
    const sender = { id: 1, isDestroyed: () => false, once: vi.fn() };
    await handler(ev(sender), {
      processes: false,
      disks: false,
      sensors: false,
      appResources: true,
      app_roots: [{ pid: 1, role: "desktop" }],
    });
    expect(bridge.subscribe).toHaveBeenCalledWith({
      processes: false,
      disks: false,
      sensors: false,
      appResources: true,
    });
    await expect(
      handler(ev(sender), { processes: false, disks: false, sensors: false, appResources: "yes" }),
    ).rejects.toThrow("demand");
  });
  it("denies unregistered and non-main renderers before native calls", async () => {
    const bridge = { subscribe: vi.fn(), addRenderer: vi.fn() };
    registerSystemMonitorIpc(bridge as never, (sender) => sender.id === 1);
    const handler = handlers.get(desktopIpcChannels.systemMonitorSubscribe)!;
    const demand = { processes: false, disks: false, sensors: false };
    for (const sender of [
      { id: 2, isDestroyed: () => false },
      { id: 3, isDestroyed: () => false },
    ]) {
      await expect(handler(ev(sender), demand)).rejects.toThrow("denied");
    }
    expect(bridge.subscribe).not.toHaveBeenCalled();
  });
  it("unsubscribes a main renderer's subscriptions on destruction", async () => {
    let destroyed: (() => void) | undefined;
    const sender = {
      id: 1,
      isDestroyed: () => false,
      once: (_name: string, listener: () => void) => {
        destroyed = listener;
      },
    };
    const bridge = { subscribe: vi.fn(async () => 7), unsubscribe: vi.fn(), addRenderer: vi.fn() };
    registerSystemMonitorIpc(bridge as never, (candidate) => candidate.id === 1);
    const handler = handlers.get(desktopIpcChannels.systemMonitorSubscribe)!;
    await expect(
      handler(ev(sender), { processes: true, disks: false, sensors: false }),
    ).resolves.toBe(7);
    destroyed?.();
    expect(bridge.unsubscribe).toHaveBeenCalledWith(7);
  });
  it("rejects oversized process filters before invoking Rust", async () => {
    const bridge = { query: vi.fn(), addRenderer: vi.fn() };
    registerSystemMonitorIpc(bridge as never, (sender) => sender.id === 1);
    const handler = handlers.get(desktopIpcChannels.systemMonitorQuery)!;
    const sender = { id: 1, isDestroyed: () => false, once: vi.fn() };
    expect(() =>
      handler(ev(sender), { name: "x".repeat(257), sort: "cpu", descending: true, limit: 100 }),
    ).toThrow("filter");
    expect(() =>
      handler(ev(sender), { search: "🔥".repeat(65), sort: "cpu", descending: true, limit: 100 }),
    ).toThrow("filter");
    expect(bridge.query).not.toHaveBeenCalled();
    handler(ev(sender), { search: "run", sort: "cpu", descending: true, limit: 100 });
    expect(bridge.query).toHaveBeenCalledWith({
      search: "run",
      sort: "cpu",
      descending: true,
      limit: 100,
    });
  });
});
