import { WS_METHODS } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  formatWsReconnectAttempt,
  getWsConnectionStatus,
  isWsReconnectPastLabelCap,
} from "./wsConnectionState";
import { WsTransport } from "./wsTransport";
import { WsTransportDisconnectedError } from "./wsTransport.errors";
import { WS_RECONNECT_LABEL_MAX_ATTEMPTS } from "./wsReconnectPolicy";
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
      values: [{ version: 1, type: "welcome", sequence, payload: { cwd: "/f", projectName: "f" } }],
    }),
  );
}

async function settle(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("never-give-up reconnect", () => {
  it("keeps retrying well past the old eight-attempt cap", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    createTransport(transports, "ws://localhost:3020");
    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket(sockets).open();
    const failedAttempts = WS_RECONNECT_LABEL_MAX_ATTEMPTS + 4;
    for (let attempt = 1; attempt <= failedAttempts; attempt += 1) {
      getSocket(sockets).close(1006, "server unreachable");
      await waitFor(() => expect(sockets).toHaveLength(attempt + 1));
    }
    const status = getWsConnectionStatus();
    expect(status.reconnectPhase).not.toBe("exhausted");
    expect(status.reconnectAttemptCount).toBe(failedAttempts);
    expect(isWsReconnectPastLabelCap(status)).toBe(true);
    expect(formatWsReconnectAttempt(status)).toBe(String(failedAttempts));
    getSocket(sockets).open();
    await waitFor(() => expect(getWsConnectionStatus().phase).toBe("connected"));
  });

  it("fails requests fast while disconnected, but waits during the first connection", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const transport = createTransport(transports, "ws://localhost:3020");
    const firstRequest = transport.request((client) => client[WS_METHODS.serverPing]({}));
    const pending = Symbol("pending");
    await expect(
      Promise.race([firstRequest.catch(() => "rejected"), settle(50).then(() => pending)]),
    ).resolves.toBe(pending);
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    await waitFor(() => expect(requests(socket)).toHaveLength(1));
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requests(socket)[0]!.id,
        exit: { _tag: "Success", value: { serverTime: "now" } },
      }),
    );
    await firstRequest;

    socket.close(1006, "dropped");
    await waitFor(() => expect(getWsConnectionStatus().reconnectPhase).toBe("waiting"));
    expect(transport.isDisconnected).toBe(true);
    const startedAt = Date.now();
    await expect(
      transport.request((client) => client[WS_METHODS.serverPing]({})),
    ).rejects.toBeInstanceOf(WsTransportDisconnectedError);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("keeps subscriptions on the live reconnect and resumes them after a wake", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const transport = createTransport(transports, "ws://localhost:3020");
    const listener = vi.fn();
    const onError = vi.fn();
    const stop = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onError, retryDelay: 1 },
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const first = getSocket(sockets);
    first.open();
    await waitFor(() => expect(requests(first)).toHaveLength(1));
    welcome(first, requests(first)[0]!.id, 1);
    await waitFor(() => expect(listener).toHaveBeenCalledOnce());

    first.close(1006, "dropped");
    // With a 1 s ceiling the next attempt is scheduled; a wake must not wait for it.
    await waitFor(() => expect(getWsConnectionStatus().reconnectPhase).toBe("waiting"));
    expect(transport.reconnectNow()).toBe(true);
    await waitFor(() => expect(sockets).toHaveLength(2), 500);
    const second = getSocket(sockets);
    // An attempt is in flight now, so further wake signals are ignored.
    expect(transport.reconnectNow()).toBe(false);
    second.open();
    await waitFor(() => expect(requests(second)).toHaveLength(1), 2_000);
    welcome(second, requests(second)[0]!.id, 2);
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(onError).not.toHaveBeenCalled();
    expect(transport.reconnectNow()).toBe(false);
    stop();
  });
});
