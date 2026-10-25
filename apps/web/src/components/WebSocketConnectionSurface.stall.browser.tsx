import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

interface Notice {
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
}

const mocks = vi.hoisted(() => ({
  add: vi.fn((_toast: Notice) => "toast-1"),
  update: vi.fn((_id: unknown, _toast: Notice) => undefined),
  close: vi.fn((_id: unknown) => undefined),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: mocks.add, update: mocks.update, close: mocks.close },
}));
vi.mock("../rpc/wsRpcClient", () => ({
  getWsRpcClient: () => ({
    reconnect: () => Promise.resolve(),
    reconnectNow: () => false,
    server: { ping: () => new Promise<never>(() => undefined) },
  }),
}));

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { recordServerStall, resetServerStallStateForTests } from "../rpc/serverStallState";
import {
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../rpc/wsConnectionState";
import { WebSocketConnectionCoordinator } from "./WebSocketConnectionSurface.coordinator";

function freeze(durationMs: number, startedAtMs: number) {
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(startedAtMs + durationMs).toISOString(),
    durationMs,
    spans: [{ name: "sql.execute", startedAt: new Date(startedAtMs).toISOString(), endedAt: null }],
    inFlightRpcMethods: [],
  };
}

function allToasts(): Notice[] {
  return [
    ...mocks.add.mock.calls.map(([toast]) => toast),
    ...mocks.update.mock.calls.map(([, toast]) => toast),
  ];
}

async function renderCoordinator() {
  return render(
    <AppAtomRegistryProvider>
      <WebSocketConnectionCoordinator />
    </AppAtomRegistryProvider>,
  );
}

beforeEach(() => {
  resetWsConnectionStateForTests();
  resetServerStallStateForTests();
});
afterEach(() => {
  resetWsConnectionStateForTests();
  resetServerStallStateForTests();
  vi.clearAllMocks();
});

describe("stall explanation in the recovery toast", () => {
  it("rewrites the visible recovery toast when the stall report arrives after reconnect", async () => {
    await renderCoordinator();
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    const freezeStartedAt = Date.now();
    recordWsConnectionClosed({ code: 1006, reason: "heartbeat" });
    await vi.waitFor(() =>
      expect(allToasts().some((toast) => toast.type === "loading")).toBe(true),
    );
    recordWsConnectionOpened();
    await vi.waitFor(() =>
      expect(allToasts().some((toast) => toast.type === "success")).toBe(true),
    );
    expect(allToasts().some((toast) => /busy/.test(toast.description ?? ""))).toBe(false);

    recordServerStall(freeze(75_000, freezeStartedAt - 20_000));
    await vi.waitFor(() => {
      const last = mocks.update.mock.calls.at(-1)?.[1];
      expect(last?.type).toBe("success");
      expect(last?.description).toMatch(/busy for 75s while running sql\.execute/);
    });
    expect(mocks.add.mock.calls.filter(([toast]) => toast.type === "info")).toHaveLength(0);
    expect(allToasts().every((toast) => toast.type !== "error")).toBe(true);
  });

  it("folds a stall reported before recovery into the recovery toast", async () => {
    await renderCoordinator();
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    const freezeStartedAt = Date.now();
    recordWsConnectionClosed({ code: 1006, reason: "heartbeat" });
    await vi.waitFor(() =>
      expect(allToasts().some((toast) => toast.type === "loading")).toBe(true),
    );
    recordServerStall(freeze(30_000, freezeStartedAt - 10_000));
    recordWsConnectionOpened();
    await vi.waitFor(() => {
      const success = allToasts().find((toast) => toast.type === "success");
      expect(success?.description).toMatch(/busy for 30s/);
    });
  });

  it("leaves unrelated stalls out of the UI", async () => {
    await renderCoordinator();
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordServerStall(freeze(2_000, Date.now() - 600_000));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(allToasts().some((toast) => /busy/.test(toast.description ?? ""))).toBe(false);
  });
});
