import { WS_METHODS } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

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

type WireMessage = { readonly _tag: string; readonly id?: string; readonly tag?: string };

const wireMessages = (socket: MockWebSocket): WireMessage[] =>
  socket.sent.map((message) => JSON.parse(message) as WireMessage);

const subscriptionRequests = (socket: MockWebSocket) =>
  wireMessages(socket).filter(
    (message) => message._tag === "Request" && message.tag === WS_METHODS.subscribeServerLifecycle,
  );

// The Effect RPC pinger writes a Ping every 5 s and gives up when the next tick finds no Pong.
const PING_TIMEOUT_MS = 10_500;

describe("WsTransport ping timeout recovery", () => {
  it("re-requests live subscriptions after the client replaces a silent socket", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const transport = createTransport(transports, "ws://localhost:3020");
    const listener = vi.fn();
    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { retryDelay: 1 },
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    const silentSocket = getSocket(sockets);
    silentSocket.open();
    await waitFor(() => expect(subscriptionRequests(silentSocket)).toHaveLength(1));

    // The server is alive but frozen: it never answers the pinger.
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await waitFor(() => expect(silentSocket.readyState).toBe(MockWebSocket.CLOSED));

    await vi.advanceTimersByTimeAsync(2_000);
    await waitFor(() => expect(sockets.length).toBeGreaterThan(1));
    const replacement = getSocket(sockets);
    replacement.open();

    await vi.advanceTimersByTimeAsync(2_000);
    await waitFor(() => expect(subscriptionRequests(replacement)).toHaveLength(1), 3_000);

    unsubscribe();
    vi.useRealTimers();
  }, 30_000);

  it("re-requests live subscriptions after the server drops the socket (control)", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      vi.fn(),
      { retryDelay: 1 },
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    const first = getSocket(sockets);
    first.open();
    await waitFor(() => expect(subscriptionRequests(first)).toHaveLength(1));

    first.close(1006, "server crashed");
    await waitFor(() => expect(sockets.length).toBeGreaterThan(1), 3_000);
    const replacement = getSocket(sockets);
    replacement.open();
    await waitFor(() => expect(subscriptionRequests(replacement)).toHaveLength(1), 3_000);

    unsubscribe();
  }, 15_000);
});
