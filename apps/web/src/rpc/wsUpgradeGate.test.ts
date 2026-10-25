import { describe, expect, it, vi } from "vitest";

import { WsTransport } from "./wsTransport";
import { WsUpgradeGate } from "./wsUpgradeGate";
import {
  MockWebSocket,
  createTransport,
  getSocket,
  registerTestHooks,
  waitFor,
} from "./wsTransport.test.helpers";

const sockets: MockWebSocket[] = [];
const transports: WsTransport[] = [];
registerTestHooks(sockets, transports);

/** Models a frozen server: closing an upgrade does not report `close` until released. */
class FrozenUpgradeSocket extends MockWebSocket {
  override close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSING;
    this.pendingClose = () => super.close(code, reason);
  }
  pendingClose: (() => void) | null = null;
}

function fakeSocket() {
  const listeners = new Map<string, () => void>();
  return {
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    emit: (type: string) => listeners.get(type)?.(),
  };
}

describe("WsUpgradeGate", () => {
  it("settles once the pending upgrade opens or closes", async () => {
    const gate = new WsUpgradeGate();
    await gate.whenSettled();
    const socket = fakeSocket();
    gate.track(socket);
    const settled = vi.fn();
    void gate.whenSettled().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    socket.emit("open");
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(gate.hasPendingUpgrade).toBe(false);

    const failing = fakeSocket();
    gate.track(failing);
    failing.emit("close");
    await gate.whenSettled();
  });

  it("releases a lost upgrade after its bound so retries can never wedge", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const gate = new WsUpgradeGate(1_000, () => now);
      gate.track(fakeSocket());
      const settled = vi.fn();
      void gate.whenSettled().then(settled);
      now = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toHaveBeenCalledOnce();
      expect(gate.hasPendingUpgrade).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("transport storm guard", () => {
  it("never opens a second socket while the previous upgrade is still pending", async () => {
    globalThis.WebSocket = FrozenUpgradeSocket as unknown as typeof WebSocket;
    const transport = createTransport(transports, "ws://localhost:3020");
    await waitFor(() => expect(sockets).toHaveLength(1));
    const frozen = getSocket(sockets) as FrozenUpgradeSocket;
    // Wake signals do not stack attempts on top of an in-flight upgrade.
    expect(transport.reconnectNow()).toBe(false);
    const reconnecting = transport.reconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frozen.readyState).toBe(MockWebSocket.CLOSING);
    expect(sockets).toHaveLength(1);
    frozen.pendingClose?.();
    await reconnecting;
    await waitFor(() => expect(sockets).toHaveLength(2));
  });
});
