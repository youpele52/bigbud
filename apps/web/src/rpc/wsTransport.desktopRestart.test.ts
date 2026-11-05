import { WS_METHODS } from "@bigbud/contracts";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";
import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";
import { describe, expect, it, vi } from "vitest";

import { WsTransport } from "./wsTransport";
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

function installBackend() {
  let state: DesktopBackendStartupState = { generation: 1, startedAt: 1, status: "ready" };
  let url = "ws://127.0.0.1:13774/?token=old-token";
  const listeners = new Set<(state: DesktopBackendStartupState) => void>();
  window.desktopBridge = {
    getWsUrl: () => url,
    getBackendStartupState: async () => state,
    onBackendStartupState: (listener: (state: DesktopBackendStartupState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as DesktopBridge;
  return {
    listeners,
    publish: (status: DesktopBackendStartupState["status"], nextUrl = url) => {
      url = nextUrl;
      state = { generation: 2, startedAt: 2, status };
      for (const listener of listeners) listener(state);
    },
  };
}

function welcome(socket: MockWebSocket, sequence: number) {
  const request = socket.sent
    .map((frame) => JSON.parse(frame))
    .find((frame) => frame._tag === "Request");
  expect(request).toBeDefined();
  socket.serverMessage(
    JSON.stringify({
      _tag: "Chunk",
      requestId: request.id,
      values: [{ version: 1, type: "welcome", sequence, payload: { cwd: "/f", projectName: "f" } }],
    }),
  );
}

describe("desktop socket retry readiness", () => {
  it("waits through restart failures and resumes subscriptions at the newly published endpoint", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const backend = installBackend();
    const transport = createTransport(transports);
    const listener = vi.fn();
    const stop = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { retryDelay: 1 },
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const first = getSocket(sockets);
    first.open();
    await waitFor(() => expect(first.sent.length).toBeGreaterThan(0));
    welcome(first, 1);
    await waitFor(() => expect(listener).toHaveBeenCalledOnce());

    backend.publish("starting");
    first.close(1012, "service restart");
    await waitFor(() => expect(backend.listeners.size).toBe(1));
    backend.publish("failed");
    transport.reconnectNow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets).toHaveLength(1);
    expect(backend.listeners.size).toBe(1);

    backend.publish("ready", "ws://127.0.0.1:3774/?token=new-token");
    await waitFor(() => expect(sockets).toHaveLength(2));
    const second = getSocket(sockets);
    expect(second.url).toBe("ws://127.0.0.1:3774/ws?token=new-token");
    second.open();
    await waitFor(() => expect(second.sent.length).toBeGreaterThan(0));
    welcome(second, 2);
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(backend.listeners.size).toBe(0);
    stop();
  });

  it("keeps subscriptions pending after startup failure instead of retrying a dead endpoint", async () => {
    const backend = installBackend();
    backend.publish("failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transport = createTransport(transports);
    const listener = vi.fn();
    const onError = vi.fn();
    const stop = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onError },
    );
    await waitFor(() => expect(backend.listeners.size).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sockets).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    backend.publish("ready");
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    welcome(socket, 1);
    await waitFor(() => expect(listener).toHaveBeenCalledOnce());
    stop();
  });

  it("cancels a restart readiness wait on disposal without constructing a late socket", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const backend = installBackend();
    const transport = createTransport(transports);
    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket(sockets).open();
    backend.publish("starting");
    getSocket(sockets).close(1012, "service restart");
    await waitFor(() => expect(backend.listeners.size).toBe(1));

    await transport.dispose();
    expect(backend.listeners.size).toBe(0);
    backend.publish("ready");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sockets).toHaveLength(1);
  });

  it("keeps explicit connection targets when desktop publishes a new endpoint", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const backend = installBackend();
    createTransport(transports, "ws://remote.example:4222/?token=explicit-token");
    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket(sockets).open();
    backend.publish("ready", "ws://127.0.0.1:3774/?token=new-token");
    getSocket(sockets).close(1006);
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(getSocket(sockets).url).toBe("ws://remote.example:4222/ws?token=explicit-token");
  });
});
