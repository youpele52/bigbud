import { WS_METHODS } from "@bigbud/contracts";
import { Cause, Duration, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { serverConfigFixture } from "./serverConfig.test.fixture";
import { withWsInitialApplicationDeadline } from "./wsTransport.initialValue";
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

function requests(socket: MockWebSocket) {
  return socket.sent
    .map((frame) => JSON.parse(frame) as { _tag: string; id?: string; requestId?: string })
    .filter((message) => message._tag === "Request");
}

describe("config initial application deadline", () => {
  it("cancels timed-out request scopes before replacing them and exhausts the retry budget", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    let failures = 0;
    const onError = vi.fn();
    const stop = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerConfig]({}),
      vi.fn(),
      {
        initialApplication: { timeout: Duration.millis(250) },
        retryDelay: 1,
        shouldRetry: (error) => {
          expect(Cause.isTimeoutError(error)).toBe(true);
          failures += 1;
          return failures < 2;
        },
        onError,
      },
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    await waitFor(() => expect(requests(socket)).toHaveLength(1));
    const first = requests(socket)[0]!.id;
    await waitFor(() => expect(requests(socket)).toHaveLength(2));
    const wire = socket.sent.map((frame) => JSON.parse(frame));
    const interruptIndex = wire.findIndex(
      (message) => message._tag === "Interrupt" && message.requestId === first,
    );
    expect(interruptIndex).toBeGreaterThanOrEqual(0);
    expect(interruptIndex).toBeLessThan(
      wire.findIndex((message) => message._tag === "Request" && message.id !== first),
    );
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(failures).toBe(2);
    expect(Cause.isTimeoutError(onError.mock.calls[0]![0])).toBe(true);
    expect(requests(socket)).toHaveLength(2);
    stop();
  });

  it("disarms after successful application and never imposes an idle inter-message deadline", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const listener = vi.fn();
    const onError = vi.fn();
    const stop = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerConfig]({}),
      listener,
      {
        initialApplication: { timeout: Duration.millis(250) },
        shouldRetry: () => false,
        onError,
      },
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    await waitFor(() => expect(requests(socket)).toHaveLength(1));
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requests(socket)[0]!.id,
        values: [{ version: 1, type: "snapshot", config: serverConfigFixture }],
      }),
    );
    await waitFor(() => expect(listener).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(onError).not.toHaveBeenCalled();
    expect(requests(socket)).toHaveLength(1);
    stop();
  });

  it("does not disarm for receipt of a value that was not an initial applied snapshot", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const listener = vi.fn();
    const onError = vi.fn();
    const stop = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerConfig]({}),
      listener,
      {
        initialApplication: { timeout: Duration.millis(250), isApplied: () => false },
        shouldRetry: () => false,
        onError,
      },
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    await waitFor(() => expect(requests(socket)).toHaveLength(1));
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requests(socket)[0]!.id,
        values: [{ version: 1, type: "providerStatuses", payload: { providers: [] } }],
      }),
    );
    await waitFor(() => expect(listener).toHaveBeenCalledOnce());
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    stop();
  });

  it("interrupts the scoped watchdog and consumer immediately on disposal", async () => {
    let active = 0;
    let finalized = 0;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const fiber = Effect.runFork(
      Effect.scoped(
        withWsInitialApplicationDeadline({ timeout: Duration.seconds(15) }, () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              active += 1;
              resolveReady();
            }),
            () =>
              Effect.sync(() => {
                active -= 1;
                finalized += 1;
              }),
          ).pipe(Effect.andThen(Effect.never)),
        ),
      ),
    );
    await ready;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(active).toBe(0);
    expect(finalized).toBe(1);
  });
});
