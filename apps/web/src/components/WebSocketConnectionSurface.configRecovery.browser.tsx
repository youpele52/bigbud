import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

interface Notice {
  readonly title?: string;
  readonly type?: string;
  readonly description?: string;
  readonly actionProps?: { readonly children?: string; readonly onClick?: () => void };
}

const mocks = vi.hoisted(() => {
  let nextId = 0;
  return {
    add: vi.fn((_toast: Notice) => `notice-${++nextId}`),
    update: vi.fn((_id: string, _toast: Notice) => undefined),
    close: vi.fn((_id: string) => undefined),
    reconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  };
});
vi.mock("./ui/toast", () => ({
  toastManager: { add: mocks.add, update: mocks.update, close: mocks.close },
}));
vi.mock("./WebSocketConnectionSurface.heartbeat", () => ({
  useWebSocketHeartbeat: () => ({ invalidate: () => undefined, probeNow: () => undefined }),
}));
vi.mock("../rpc/wsRpcClient", () => ({
  getWsRpcClient: () => ({ reconnect: mocks.reconnect, reconnectNow: () => false }),
}));

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import {
  getServerConfig,
  resetServerStateForTests,
  setServerConfigSnapshot,
} from "../rpc/serverState";
import { serverConfigFixture } from "../rpc/serverConfig.test.fixture";
import {
  beginServerConfigReadiness,
  registerServerConfigRetry,
  updateServerConfigReadiness,
} from "../rpc/serverConfigReadiness";
import {
  recordWsConnectionAttempt,
  recordWsConnectionOpened,
  recordWsProtocolRecovery,
  resetWsConnectionStateForTests,
} from "../rpc/wsConnectionState";
import { WebSocketConnectionCoordinator } from "./WebSocketConnectionSurface.coordinator";

let screen: Awaited<ReturnType<typeof render>> | null = null;
let stopOwner: (() => void) | null = null;
beforeEach(() => {
  resetServerStateForTests();
  resetWsConnectionStateForTests();
  setServerConfigSnapshot(serverConfigFixture);
  recordWsConnectionAttempt("ws://localhost:3020/ws");
  recordWsConnectionOpened();
});
afterEach(async () => {
  await screen?.unmount();
  screen = null;
  stopOwner?.();
  stopOwner = null;
  resetServerStateForTests();
  resetWsConnectionStateForTests();
  mocks.add.mockClear();
  mocks.update.mockClear();
  mocks.close.mockClear();
  mocks.reconnect.mockReset();
  mocks.reconnect.mockResolvedValue(undefined);
});

async function pausedNotice() {
  await vi.waitFor(() =>
    expect(
      mocks.add.mock.calls.some(([notice]) => notice.title === "Configuration updates paused"),
    ).toBe(true),
  );
  const index = mocks.add.mock.calls.findIndex(
    ([notice]) => notice.title === "Configuration updates paused",
  );
  return {
    notice: mocks.add.mock.calls[index]![0],
    id: mocks.add.mock.results[index]!.value as string,
  };
}

describe("real cached config recovery coordinator", () => {
  it("warns without clearing cached config, offers retry, and closes after live application", async () => {
    const generation = beginServerConfigReadiness(true);
    updateServerConfigReadiness(generation, {
      stream: "exhausted",
      failure: "initial_snapshot_timeout",
    });
    const retry = vi.fn(() =>
      updateServerConfigReadiness(generation, { stream: "pending", failure: null }),
    );
    stopOwner = registerServerConfigRetry(generation, retry);
    screen = await render(
      <AppAtomRegistryProvider>
        <WebSocketConnectionCoordinator />
      </AppAtomRegistryProvider>,
    );
    const { notice, id } = await pausedNotice();
    expect(notice.type).toBe("warning");
    expect(getServerConfig()).toEqual(serverConfigFixture);
    expect(notice.actionProps?.children).toBe("Retry configuration");
    notice.actionProps?.onClick?.();
    expect(retry).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(id, expect.objectContaining({ type: "info" })),
    );
    expect(mocks.close).not.toHaveBeenCalled();
    expect(getServerConfig()).toEqual(serverConfigFixture);
    updateServerConfigReadiness(generation, { stream: "live" });
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledWith(id));
  });

  it("closes its existing warning when the coordinator unmounts", async () => {
    const generation = beginServerConfigReadiness(true);
    updateServerConfigReadiness(generation, { stream: "exhausted" });
    screen = await render(
      <AppAtomRegistryProvider>
        <WebSocketConnectionCoordinator />
      </AppAtomRegistryProvider>,
    );
    const { id } = await pausedNotice();
    await screen.unmount();
    screen = null;
    expect(mocks.close).toHaveBeenCalledWith(id);
  });

  it("offers explicit physical reconnect and displays a fixed safe failure", async () => {
    const generation = beginServerConfigReadiness(true);
    updateServerConfigReadiness(generation, { stream: "exhausted", failure: "protocol_failed" });
    recordWsProtocolRecovery();
    mocks.reconnect.mockRejectedValueOnce(new Error("token=private-token /private/provider/path"));
    screen = await render(
      <AppAtomRegistryProvider>
        <WebSocketConnectionCoordinator />
      </AppAtomRegistryProvider>,
    );
    const { notice } = await pausedNotice();
    expect(notice.actionProps?.children).toBe("Reconnect");
    notice.actionProps?.onClick?.();
    await vi.waitFor(() =>
      expect(mocks.add.mock.calls.some(([item]) => item.title === "Reconnect failed")).toBe(true),
    );
    expect(JSON.stringify(mocks.add.mock.calls)).not.toContain("private-token");
    expect(JSON.stringify(mocks.add.mock.calls)).not.toContain("/private/provider/path");
  });
});
