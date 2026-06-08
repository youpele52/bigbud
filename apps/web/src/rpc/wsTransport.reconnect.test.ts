import { WS_METHODS } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { getSlowRpcAckRequests, setSlowRpcAckThresholdMsForTests } from "./requestLatencyState";
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

describe("WsTransport reconnect", () => {
  it("clears slow unary request tracking when the transport reconnects", async () => {
    const slowAckThresholdMs = 25;
    setSlowRpcAckThresholdMsForTests(slowAckThresholdMs);
    const transport = createTransport(transports, "ws://localhost:3020");

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "terminal.toggle",
        key: "ctrl+k",
      }),
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket(sockets);
    firstSocket.open();

    await waitFor(() => {
      expect(firstSocket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(firstSocket.sent[0] ?? "{}") as { id: string };

    await waitFor(() => {
      expect(getSlowRpcAckRequests()).toMatchObject([
        {
          requestId: firstRequest.id,
          tag: WS_METHODS.serverUpsertKeybinding,
        },
      ]);
    }, 1_000);

    void requestPromise.catch(() => undefined);

    await transport.reconnect();

    expect(getSlowRpcAckRequests()).toEqual([]);

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket(sockets);
    secondSocket.open();

    await transport.dispose();
  }, 5_000);

  it("re-subscribes live stream listeners after an explicit transport reconnect", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket(sockets);
    firstSocket.open();

    await waitFor(() => {
      expect(firstSocket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(firstSocket.sent[0] ?? "{}") as { id: string };
    const firstEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        cwd: "/tmp/one",
        projectName: "one",
      },
    };

    firstSocket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [firstEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(firstEvent);
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket(sockets);
    expect(secondSocket).not.toBe(firstSocket);
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);

    secondSocket.open();

    await waitFor(() => {
      expect(secondSocket.sent).toHaveLength(1);
    });

    const secondRequest = JSON.parse(secondSocket.sent[0] ?? "{}") as {
      id: string;
      tag: string;
    };
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    expect(secondRequest.id).not.toBe(firstRequest.id);
    expect(onResubscribe).toHaveBeenCalledOnce();

    const secondEvent = {
      version: 1,
      sequence: 2,
      type: "welcome",
      payload: {
        cwd: "/tmp/two",
        projectName: "two",
      },
    };

    secondSocket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: secondRequest.id,
        values: [secondEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(secondEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("ignores stale socket lifecycle events after reconnect starts a new session", async () => {
    const onClose = vi.fn();
    const transport = createTransport(transports, "ws://localhost:3020", { onClose });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket(sockets);
    firstSocket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(getWsConnectionStatus()).toMatchObject({
      closeCode: null,
      closeReason: null,
      phase: "connecting",
    });

    const secondSocket = getSocket(sockets);
    secondSocket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        phase: "connected",
      });
    });

    firstSocket.close(1006, "stale close");

    expect(onClose).not.toHaveBeenCalled();
    expect(getWsConnectionStatus()).toMatchObject({
      closeCode: null,
      closeReason: null,
      phase: "connected",
    });

    await transport.dispose();
  });
});
