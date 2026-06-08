import { afterEach, beforeEach, vi } from "vitest";

import { resetRequestLatencyStateForTests } from "./requestLatencyState";
import { resetWsConnectionStateForTests } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";

export type WsEventType = "open" | "message" | "close" | "error";
export type WsEvent = { code?: number; data?: unknown; reason?: string; type?: string };
export type WsListener = (event?: WsEvent) => void;

export const originalWebSocket = globalThis.WebSocket;

export class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Called by the constructor so per-file arrays can track instances. */
  static onCreate: ((ws: MockWebSocket) => void) | null = null;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.onCreate?.(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: unknown) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: WsEventType, event?: WsEvent) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

export async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

export function createTransport(
  transports: WsTransport[],
  ...args: ConstructorParameters<typeof WsTransport>
): WsTransport {
  const transport = new WsTransport(...args);
  transports.push(transport);
  return transport;
}

export function getSocket(sockets: MockWebSocket[]): MockWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

export function registerTestHooks(sockets: MockWebSocket[], transports: WsTransport[]) {
  beforeEach(() => {
    vi.useRealTimers();
    sockets.length = 0;
    transports.length = 0;
    resetRequestLatencyStateForTests();
    resetWsConnectionStateForTests();

    MockWebSocket.onCreate = (ws) => {
      sockets.push(ws);
    };

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          origin: "http://localhost:3020",
          hostname: "localhost",
          port: "3020",
          protocol: "http:",
        },
        desktopBridge: undefined,
      },
    });

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(async () => {
    await Promise.allSettled(transports.map((transport) => transport.dispose()));
    transports.length = 0;
    globalThis.WebSocket = originalWebSocket;
    resetRequestLatencyStateForTests();
    resetWsConnectionStateForTests();
    vi.restoreAllMocks();
    MockWebSocket.onCreate = null;
  });
}
