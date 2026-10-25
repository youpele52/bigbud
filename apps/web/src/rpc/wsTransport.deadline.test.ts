import { WS_METHODS } from "@bigbud/contracts";
import { Duration, Effect, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { getServerConfig, resetServerStateForTests, startServerStateSync } from "./serverState";
import { getServerConfigReadiness, retryServerConfigSync } from "./serverConfigReadiness";
import { serverConfigFixture } from "./serverConfig.test.fixture";
import { createWsRpcClient } from "./wsRpcClient";
import { CONFIG_FALLBACK_DEADLINE_MS, requestServerConfig } from "./wsRpcClient.config";
import { WsTransport } from "./wsTransport";
import { scopedWsFiniteRequest } from "./wsTransport.request";
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

function wireRequests(socket: MockWebSocket) {
  return socket.sent
    .map(
      (frame) =>
        JSON.parse(frame) as { _tag: string; tag?: string; id: string; requestId?: string },
    )
    .filter((message) => message._tag === "Request" && message.tag === WS_METHODS.serverGetConfig);
}

describe("read-only config request deadlines", () => {
  it("opts only getConfig into a 15-second deadline without changing its public signature", async () => {
    const deadlines: Array<Option.Option<Duration.Input> | undefined> = [];
    const request: WsTransport["request"] = async <A>(
      _execute: unknown,
      options?: { timeout?: Option.Option<Duration.Input> },
    ) => {
      deadlines.push(options?.timeout);
      return serverConfigFixture as unknown as A;
    };
    await requestServerConfig({ request });
    const timeout = deadlines[0];
    expect(CONFIG_FALLBACK_DEADLINE_MS).toBe(15_000);
    expect(
      timeout && Option.isSome(timeout)
        ? Duration.toMillis(Duration.fromInputUnsafe(timeout.value))
        : null,
    ).toBe(15_000);
    await createWsRpcClient({ request } as unknown as WsTransport).server.updateSettings({});
    expect(deadlines[1]).toBeUndefined();
  });

  it("cancels an underlying timed-out unary RPC rather than merely abandoning its promise", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    const request = transport.request((client) => client[WS_METHODS.serverGetConfig]({}), {
      timeout: Option.some(Duration.millis(250)),
    });
    const rejected = expect(request).rejects.toThrow();
    await waitFor(() => expect(wireRequests(socket)).toHaveLength(1));
    const id = wireRequests(socket)[0]!.id;
    await rejected;
    await waitFor(() =>
      expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        _tag: "Interrupt",
        requestId: id,
      }),
    );
  });

  it("surfaces a hung fallback deadline and starts a fresh fallback on explicit retry", async () => {
    resetServerStateForTests();
    const transport = createTransport(transports, "ws://localhost:3020");
    const originalRequest = transport.request.bind(transport);
    vi.spyOn(transport, "request").mockImplementation((execute, options) =>
      originalRequest(
        execute,
        options?.timeout && Option.isSome(options.timeout)
          ? { ...options, timeout: Option.some(Duration.millis(250)) }
          : options,
      ),
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    const client = createWsRpcClient(transport);
    const stop = startServerStateSync(client.server);
    try {
      await waitFor(() => expect(wireRequests(socket)).toHaveLength(1));
      const staleId = wireRequests(socket)[0]!.id;
      await waitFor(() => expect(getServerConfigReadiness().fallback).toBe("failed"));
      expect(getServerConfigReadiness().failure).toBe("fallback_failed");
      retryServerConfigSync();
      await waitFor(() => expect(wireRequests(socket)).toHaveLength(2));
      socket.serverMessage(
        JSON.stringify({
          _tag: "Exit",
          requestId: staleId,
          exit: { _tag: "Success", value: { ...serverConfigFixture, cwd: "/stale" } },
        }),
      );
      expect(getServerConfig()).toBeNull();
      socket.serverMessage(
        JSON.stringify({
          _tag: "Exit",
          requestId: wireRequests(socket)[1]!.id,
          exit: { _tag: "Success", value: serverConfigFixture },
        }),
      );
      await waitFor(() => expect(getServerConfig()).toEqual(serverConfigFixture));
    } finally {
      stop();
      resetServerStateForTests();
    }
  });

  it("scopes a finite consumer failure without reconnecting or retrying the operation", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket(sockets).open();
    let active = 0;
    let finalizers = 0;
    const stream = Stream.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => {
          active += 1;
          return Stream.concat(Stream.make(1), Stream.never);
        }),
        () =>
          Effect.sync(() => {
            active -= 1;
            finalizers += 1;
          }),
      ),
    ).pipe(Stream.scoped);
    await expect(
      transport.requestStream(
        () => stream,
        () => {
          throw new Error("consumer failed");
        },
      ),
    ).rejects.toThrow();
    expect(active).toBe(0);
    expect(finalizers).toBe(1);
    expect(sockets).toHaveLength(1);
  });

  it("fences queued finite values before a retired generation can apply them", async () => {
    let active = true;
    const listener = vi.fn();
    const request = Effect.runPromise(
      scopedWsFiniteRequest(
        Promise.resolve(undefined),
        () => Stream.make(1),
        listener,
        () => active,
      ),
    );
    active = false;
    await request;
    expect(listener).not.toHaveBeenCalled();
  });
});
