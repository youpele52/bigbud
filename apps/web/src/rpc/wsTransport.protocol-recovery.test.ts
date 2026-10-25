import { WS_METHODS } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { getWsConnectionStatus } from "./wsConnectionState";
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

function requests(socket: MockWebSocket): Array<{ readonly id: string; readonly tag: string }> {
  return socket.sent
    .map((frame) => JSON.parse(frame))
    .filter((message) => message._tag === "Request");
}

function welcome(socket: MockWebSocket, requestId: string, sequence: number) {
  socket.serverMessage(
    JSON.stringify({
      _tag: "Chunk",
      requestId,
      values: [
        {
          version: 1,
          type: "welcome",
          sequence,
          payload: { cwd: "/fixture", projectName: "fixture" },
        },
      ],
    }),
  );
}

describe("physical RPC protocol recovery", () => {
  it("retires one poisoned physical generation once and resumes both logical subscribers", async () => {
    const protocolFailure = vi.fn();
    const transport = createTransport(transports, "ws://localhost:3020", {
      onProtocolFailure: protocolFailure,
    });
    const first = vi.fn();
    const second = vi.fn();
    const stopA = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      first,
    );
    const stopB = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      second,
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const old = getSocket(sockets);
    old.open();
    await waitFor(() => expect(requests(old)).toHaveLength(2));
    old.serverMessage(JSON.stringify({ _tag: "Defect", defect: "secret=must-not-be-logged" }));
    await waitFor(() => expect(sockets).toHaveLength(2), 2_000);
    expect(old.readyState).toBe(MockWebSocket.CLOSED);
    expect(protocolFailure).toHaveBeenCalledOnce();
    const replacement = getSocket(sockets);
    replacement.open();
    await waitFor(() => expect(requests(replacement)).toHaveLength(2));
    for (const request of requests(replacement)) welcome(replacement, request.id, 1);
    await waitFor(() => {
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    });
    old.serverMessage(JSON.stringify({ _tag: "Defect", defect: "stale" }));
    old.close(1006, "stale-close");
    expect(getWsConnectionStatus().phase).toBe("connected");
    expect(protocolFailure).toHaveBeenCalledOnce();
    stopA();
    stopB();
  });

  it("backs off harder on repeated protocol defects but never stops recovering", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const onError = vi.fn();
    const stop = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      vi.fn(),
      { onError },
    );
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await waitFor(() => expect(sockets).toHaveLength(attempt), 2_000);
      const socket = getSocket(sockets);
      socket.open();
      await waitFor(() => expect(requests(socket)).toHaveLength(1));
      socket.serverMessage(JSON.stringify({ _tag: "Defect", defect: "deterministic failure" }));
    }
    // The third defect inside the window escalates to the reconnect ladder instead of stopping.
    await waitFor(() => expect(getWsConnectionStatus().reconnectPhase).toBe("waiting"));
    expect(getWsConnectionStatus().nextRetryAt).not.toBeNull();
    expect(transport.isDisconnected).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(3);
    // A wake signal skips the escalated wait without dropping the logical subscriber.
    expect(transport.reconnectNow()).toBe(true);
    await waitFor(() => expect(sockets).toHaveLength(4));
    getSocket(sockets).open();
    await waitFor(() => expect(requests(getSocket(sockets))).toHaveLength(1));
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it("retires malformed-frame sessions, but not a healthy sibling for a request-local failure", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const healthy = vi.fn();
    const stop = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      healthy,
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    await waitFor(() => expect(requests(socket)).toHaveLength(1));
    const request = requests(socket)[0]!;
    welcome(socket, request.id, 1);
    await waitFor(() => expect(healthy).toHaveBeenCalledOnce());
    const unary = transport.request((client) => client[WS_METHODS.serverPing]({}));
    const rejected = expect(unary).rejects.toThrow();
    await waitFor(() => expect(requests(socket)).toHaveLength(2));
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requests(socket)[1]!.id,
        exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: "request-local" }] },
      }),
    );
    await rejected;
    welcome(socket, request.id, 2);
    await waitFor(() => expect(healthy).toHaveBeenCalledTimes(2));
    expect(sockets).toHaveLength(1);
    socket.serverMessage("{invalid-json");
    await waitFor(() => expect(sockets).toHaveLength(2), 2_000);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    stop();
  });

  it("keeps independent transports isolated when one physical session is poisoned", async () => {
    const first = createTransport(transports, "ws://localhost:3020");
    const second = createTransport(transports, "ws://localhost:3020");
    const healthy = vi.fn();
    const stopA = first.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      vi.fn(),
    );
    const stopB = second.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      healthy,
    );
    await waitFor(() => expect(sockets).toHaveLength(2));
    const badSocket = sockets[0]!;
    const healthySocket = sockets[1]!;
    badSocket.open();
    healthySocket.open();
    await waitFor(() => {
      expect(requests(badSocket)).toHaveLength(1);
      expect(requests(healthySocket)).toHaveLength(1);
    });
    badSocket.serverMessage(JSON.stringify({ _tag: "Defect", defect: "bad transport" }));
    welcome(healthySocket, requests(healthySocket)[0]!.id, 1);
    await waitFor(() => expect(healthy).toHaveBeenCalledOnce());
    expect(healthySocket.readyState).toBe(MockWebSocket.OPEN);
    stopA();
    stopB();
  });

  it("coalesces concurrent manual reconnect requests into a single replacement", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket(sockets).open();
    await Promise.all([transport.reconnect(), transport.reconnect(), transport.reconnect()]);
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[0]!.readyState).toBe(MockWebSocket.CLOSED);
  });
});
