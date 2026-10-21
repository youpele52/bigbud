import { WS_METHODS } from "@bigbud/contracts";
import { Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { WsTransport } from "./wsTransport";
import { WsSubscriptionCompletedError } from "./wsTransport.errors";
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

describe("persistent subscription retry ownership", () => {
  it("backs off successful completion even when each attempt applies a value", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const attempts: Array<number> = [];
    let failures = 0;
    const listener = vi.fn();
    const onError = vi.fn();
    const stop = transport.subscribe(() => Stream.make("same-bootstrap-value"), listener, {
      retryDelay: ({ attempt }) => {
        attempts.push(attempt);
        return 1;
      },
      shouldRetry: (error) => {
        expect(error).toBeInstanceOf(WsSubscriptionCompletedError);
        failures += 1;
        return failures < 4;
      },
      onError,
    });
    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket(sockets).open();
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(listener).toHaveBeenCalledTimes(4);
    expect(attempts).toEqual([1, 2, 3]);
    expect(sockets).toHaveLength(1);
    stop();
  });

  it("unsubscribes during backoff without replacing the canceled attempt", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const connect = vi.fn(() => Stream.fail(new Error("deterministic failure")));
    const delay = vi.fn(() => 60_000);
    const stop = transport.subscribe(connect, vi.fn(), { retryDelay: delay });
    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket(sockets).open();
    await waitFor(() => expect(delay).toHaveBeenCalledOnce());
    stop();
    await transport.dispose();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("fences a queued value before applying it across manual reconnect", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const listener = vi.fn();
    const stop = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const old = getSocket(sockets);
    old.open();
    await waitFor(() => expect(old.sent).toHaveLength(1));
    const request = JSON.parse(old.sent[0]!) as { id: string };
    old.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: request.id,
        values: [
          {
            version: 1,
            sequence: 1,
            type: "welcome",
            payload: { cwd: "/stale", projectName: "stale" },
          },
        ],
      }),
    );
    await transport.reconnect();
    expect(listener).not.toHaveBeenCalled();
    stop();
  });
});
