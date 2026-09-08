import { describe, expect, it } from "vitest";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";
import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";

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

describe("WsTransport URL normalization", () => {
  it("normalizes root websocket urls to /ws and preserves query params", async () => {
    const transport = createTransport(transports, "ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket(sockets).url).toBe("ws://localhost:3020/ws?token=secret-token");
    await transport.dispose();
  });

  it("uses wss when falling back to an https page origin", async () => {
    Object.assign(window.location, {
      origin: "https://app.example.com",
      hostname: "app.example.com",
      port: "",
      protocol: "https:",
    });

    const transport = createTransport(transports);

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket(sockets).url).toBe("wss://app.example.com/ws");
    await transport.dispose();
  });

  it("waits for desktop backend readiness before constructing the first socket", async () => {
    let listener: ((state: DesktopBackendStartupState) => void) | undefined;
    window.desktopBridge = {
      getWsUrl: () => "ws://127.0.0.1:3774/?token=desktop-token",
      getBackendStartupState: async () => ({
        generation: 1,
        startedAt: 1,
        status: "starting",
      }),
      onBackendStartupState: (next: (state: DesktopBackendStartupState) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as DesktopBridge;

    const transport = createTransport(transports);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sockets).toHaveLength(0);

    listener?.({ generation: 1, startedAt: 1, status: "ready" });
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(getSocket(sockets).url).toBe("ws://127.0.0.1:3774/ws?token=desktop-token");
    await transport.dispose();
  });

  it("cancels a stale readiness wait when reconnecting during startup", async () => {
    const listeners = new Set<(state: DesktopBackendStartupState) => void>();
    window.desktopBridge = {
      getWsUrl: () => "ws://127.0.0.1:3774/?token=desktop-token",
      getBackendStartupState: async () => ({
        generation: 1,
        startedAt: 1,
        status: "starting",
      }),
      onBackendStartupState: (listener: (state: DesktopBackendStartupState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as DesktopBridge;
    const transport = createTransport(transports);
    await waitFor(() => expect(listeners.size).toBe(1));

    await transport.reconnect();
    await waitFor(() => expect(listeners.size).toBe(1));
    expect(sockets).toHaveLength(0);

    for (const listener of listeners) {
      listener({ generation: 1, startedAt: 1, status: "ready" });
    }
    await waitFor(() => expect(sockets).toHaveLength(1));
    await transport.dispose();
    expect(listeners.size).toBe(0);
  });

  it("disposes a startup wait without constructing a socket later", async () => {
    let capturedListener: ((state: DesktopBackendStartupState) => void) | undefined;
    window.desktopBridge = {
      getWsUrl: () => "ws://127.0.0.1:3774/?token=desktop-token",
      getBackendStartupState: async () => ({
        generation: 1,
        startedAt: 1,
        status: "starting",
      }),
      onBackendStartupState: (listener: (state: DesktopBackendStartupState) => void) => {
        capturedListener = listener;
        return () => undefined;
      },
    } as unknown as DesktopBridge;
    const transport = createTransport(transports);
    await waitFor(() => expect(capturedListener).toBeTypeOf("function"));
    const staleListener = capturedListener!;

    await transport.dispose();
    staleListener({ generation: 1, startedAt: 1, status: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sockets).toHaveLength(0);
  });
});
