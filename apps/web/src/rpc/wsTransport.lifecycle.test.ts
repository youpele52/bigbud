import { Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { getWsConnectionStatus } from "./wsConnectionState";
import {
  MockWebSocket,
  createTransport,
  getSocket,
  registerTestHooks,
  waitFor,
} from "./wsTransport.test.helpers";
import { WsTransport } from "./wsTransport";

const sockets: MockWebSocket[] = [];
const transports: WsTransport[] = [];
registerTestHooks(sockets, transports);

describe("WsTransport lifecycle handlers", () => {
  it("composes custom lifecycle handlers with default websocket state tracking", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const transport = createTransport(transports, "ws://localhost:3020", {
      onOpen,
      onClose,
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket(sockets);
    socket.open();

    await waitFor(() => {
      expect(onOpen).toHaveBeenCalledOnce();
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    socket.close(1012, "service restart");

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith({
        code: 1012,
        reason: "service restart",
      });

      const status = getWsConnectionStatus();
      expect(status.closeReason).toBe("service restart");
      expect(status.hasConnected).toBe(true);
      expect(["disconnected", "connecting"]).toContain(status.phase);
    }, 2_000);

    await transport.dispose();
  });
});

describe("WsTransport disconnect logging", () => {
  it("logs a transport disconnect once even when multiple subscriptions fail together", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const unsubscribeA = transport.subscribe(
      () => Stream.fail(new Error("SocketCloseError: 1006")),
      vi.fn(),
      { retryDelay: 10 },
    );
    const unsubscribeB = transport.subscribe(
      () => Stream.fail(new Error("SocketCloseError: 1006")),
      vi.fn(),
      { retryDelay: 10 },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket(sockets).open();

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription disconnected", {
      error: "SocketCloseError: 1006",
    });

    unsubscribeA();
    unsubscribeB();
    await transport.dispose();
  });
});

describe("WsTransport dispose ordering", () => {
  it("closes the client scope on the transport runtime before disposing the runtime", async () => {
    const callOrder: string[] = [];
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    const runtime = {
      runPromise: vi.fn(async () => {
        callOrder.push("close:start");
        await closePromise;
        callOrder.push("close:done");
        return undefined;
      }),
      dispose: vi.fn(async () => {
        callOrder.push("runtime:dispose");
      }),
    };
    const closeSession = vi.fn(function (this: { session: unknown; runtime: typeof runtime }) {
      return WsTransport.prototype["closeSession"].call(this, this.session as never);
    });
    const transport = {
      disposed: false,
      session: {
        clientScope: {} as never,
        runtime,
      },
      closeSession,
    } as unknown as WsTransport;

    const disposePromise = WsTransport.prototype.dispose.call(transport);

    expect(runtime.runPromise).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect((transport as unknown as { disposed: boolean }).disposed).toBe(true);

    resolveClose();
    await disposePromise;

    await waitFor(() => {
      expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });

    expect(callOrder).toEqual(["close:start", "close:done", "runtime:dispose"]);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });
});
