import type { DesktopConnectivitySignal } from "@bigbud/contracts/server/ipc.desktop.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  add: vi.fn((_toast: unknown) => "toast-1"),
  update: vi.fn((_id: unknown, _toast: unknown) => undefined),
  close: vi.fn((_id: unknown) => undefined),
  reconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  reconnectNow: vi.fn(() => true),
  ping: vi.fn(() => new Promise<never>(() => undefined)),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: mocks.add, update: mocks.update, close: mocks.close },
}));
vi.mock("../rpc/wsRpcClient", () => ({
  getWsRpcClient: () => ({
    reconnect: mocks.reconnect,
    reconnectNow: mocks.reconnectNow,
    server: { ping: mocks.ping },
  }),
}));

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import {
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../rpc/wsConnectionState";
import { WebSocketConnectionCoordinator } from "./WebSocketConnectionSurface.coordinator";

let sequence = 0;
const listeners = new Set<(signal: DesktopConnectivitySignal) => void>();

function emit(kind: DesktopConnectivitySignal["kind"]) {
  sequence += 1;
  for (const listener of listeners)
    listener({ kind, sequence, occurredAt: Date.now(), online: true });
}

function dropConnection() {
  recordWsConnectionAttempt("ws://localhost:3020/ws");
  recordWsConnectionOpened();
  recordWsConnectionClosed({ code: 1006, reason: "dropped" });
}

beforeEach(() => {
  resetWsConnectionStateForTests();
  listeners.clear();
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      onConnectivitySignal: (listener: (signal: DesktopConnectivitySignal) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
});

afterEach(() => {
  resetWsConnectionStateForTests();
  Reflect.deleteProperty(window, "desktopBridge");
  vi.clearAllMocks();
});

async function renderCoordinator() {
  return render(
    <AppAtomRegistryProvider>
      <WebSocketConnectionCoordinator />
    </AppAtomRegistryProvider>,
  );
}

describe("desktop power and network signals", () => {
  it.each(["resume", "unlock-screen", "online"] as const)(
    "%s skips the backoff wait of a dropped connection",
    async (kind) => {
      dropConnection();
      await renderCoordinator();
      await vi.waitFor(() => expect(listeners.size).toBe(1));
      emit(kind);
      await vi.waitFor(() => expect(mocks.reconnectNow).toHaveBeenCalledOnce());
      expect(mocks.reconnect).not.toHaveBeenCalled();
    },
  );

  it("ignores lock and suspend for reconnection", async () => {
    dropConnection();
    await renderCoordinator();
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    emit("lock-screen");
    emit("suspend");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.reconnectNow).not.toHaveBeenCalled();
  });

  it("probes a socket that still looks open after resume instead of tearing it down", async () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    await renderCoordinator();
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    emit("resume");
    await vi.waitFor(() => expect(mocks.ping).toHaveBeenCalledOnce());
    expect(mocks.reconnectNow).not.toHaveBeenCalled();
    expect(mocks.reconnect).not.toHaveBeenCalled();
  });

  it.each([
    ["suspend then resume", ["suspend", "resume"]],
    ["resume without suspend (Windows timers count sleep)", ["resume"]],
  ] as const)("discards a heartbeat probe in flight across %s", async (_label, wake) => {
    const probes: Array<(error: Error) => void> = [];
    mocks.ping.mockImplementation(
      () => new Promise<never>((_resolve, reject) => probes.push(reject)),
    );
    try {
      recordWsConnectionAttempt("ws://localhost:3020/ws");
      recordWsConnectionOpened();
      await renderCoordinator();
      await vi.waitFor(() => expect(listeners.size).toBe(1));
      emit("unlock-screen");
      await vi.waitFor(() => expect(probes).toHaveLength(1));

      for (const kind of wake) emit(kind);
      // The wake starts a fresh probe instead of waiting on the stale one.
      await vi.waitFor(() => expect(probes).toHaveLength(2));
      probes[0]!(new Error("timed out across sleep"));
      probes[1]!(new Error("first real failure"));
      // One counted failure only asks for confirmation; the stale probe never counted.
      await vi.waitFor(() => expect(probes).toHaveLength(3));
      expect(mocks.reconnect).not.toHaveBeenCalled();
    } finally {
      mocks.ping.mockImplementation(() => new Promise<never>(() => undefined));
    }
  });

  it("reconnects immediately when the page becomes visible again", async () => {
    dropConnection();
    await renderCoordinator();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(mocks.reconnectNow).toHaveBeenCalledOnce());
  });

  it("shows a blue reconnecting toast and never a red exhausted toast", async () => {
    dropConnection();
    await renderCoordinator();
    await vi.waitFor(() => expect(mocks.add).toHaveBeenCalled());
    const toasts = [...mocks.add.mock.calls, ...mocks.update.mock.calls].map(
      (call) => call.at(-1) as { type?: string; description?: string },
    );
    expect(toasts.every((toast) => toast.type !== "error")).toBe(true);
    expect(toasts.some((toast) => toast.type === "loading")).toBe(true);
    expect(toasts.some((toast) => /exhausted/i.test(toast.description ?? ""))).toBe(false);
  });
});
