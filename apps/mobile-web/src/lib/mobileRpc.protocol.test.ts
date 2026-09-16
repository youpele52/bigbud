import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMobileRpcWebSocketConstructor,
  type MobileWsProtocolLifecycleHandlers,
} from "./mobileRpc.protocol";

class FakeWebSocket {
  private readonly listeners = new Map<string, EventListener>();

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }

  emit(type: "open" | "error" | "close", event: Event = new Event(type)) {
    this.listeners.get(type)?.(event);
  }
}

describe("mobile RPC protocol socket lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ignores a delayed close from a superseded socket", () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      vi.fn(function () {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      }),
    );
    const handlers: MobileWsProtocolLifecycleHandlers = {
      onClose: vi.fn(),
      onOpen: vi.fn(),
    };
    const createSocket = createMobileRpcWebSocketConstructor(handlers);

    createSocket("ws://desktop/mobile-ws");
    const first = sockets[0]!;
    first.emit("open");
    createSocket("ws://desktop/mobile-ws");
    const second = sockets[1]!;
    second.emit("open");

    setTimeout(
      () => first.emit("close", { code: 1012, reason: "superseded" } as CloseEvent),
      1_000,
    );
    vi.advanceTimersByTime(1_000);

    expect(sockets).toHaveLength(2);
    expect(handlers.onOpen).toHaveBeenCalledTimes(2);
    expect(handlers.onClose).not.toHaveBeenCalled();

    second.emit("close", { code: 1006, reason: "network" } as CloseEvent);
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });
});
