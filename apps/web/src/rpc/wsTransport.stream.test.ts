import { WS_METHODS, type OrchestrationDeliveryStreamItem } from "@bigbud/contracts";
import { Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  MockWebSocket,
  createTransport,
  getSocket,
  registerTestHooks,
  waitFor,
} from "./wsTransport.test.helpers";
import { WsTransport } from "./wsTransport";
import { recoverAndAcknowledgeDeliveryBaseline } from "../routes/-__root.delivery-routing";

const sockets: MockWebSocket[] = [];
const transports: WsTransport[] = [];
registerTestHooks(sockets, transports);

describe("WsTransport stream subscriptions", () => {
  it("reports listener failures instead of swallowing them", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const onError = vi.fn();
    const listenerError = new Error("renderer apply failed");
    transport.subscribe(
      () => Stream.make("event"),
      () => {
        throw listenerError;
      },
      { onError, shouldRetry: () => false },
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket(sockets).open();
    await waitFor(() => expect(onError).toHaveBeenCalledWith(listenerError));
  });

  it("does not reconnect a subscription after a non-retryable failure", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const shouldRetry = vi.fn(() => false);
    const onError = vi.fn();
    const unsubscribe = transport.subscribe(
      () => Stream.fail(new Error("watch unavailable")),
      vi.fn(),
      { retryDelay: 1, shouldRetry, onError },
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket(sockets).open();
    await waitFor(() => expect(shouldRetry).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shouldRetry).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "watch unavailable" }));

    unsubscribe();
    await transport.dispose();
  });

  it("delivers stream chunks to subscribers", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket(sockets);
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string; tag: string };
    expect(requestMessage.tag).toBe(WS_METHODS.subscribeServerLifecycle);

    const welcomeEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    };

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [welcomeEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenCalledWith(welcomeEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("re-subscribes stream listeners after the stream exits", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket(sockets);
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [
          {
            version: 1,
            sequence: 1,
            type: "welcome",
            payload: {
              cwd: "/tmp/one",
              projectName: "one",
            },
          },
        ],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      const nextRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; id?: string })
        .find((message) => message._tag === "Request" && message.id !== firstRequest.id);
      expect(nextRequest).toBeDefined();
    });

    const secondRequest = socket.sent
      .map((message) => JSON.parse(message) as { _tag?: string; id?: string; tag?: string })
      .find(
        (message): message is { _tag: "Request"; id: string; tag: string } =>
          message._tag === "Request" && message.id !== firstRequest.id,
      );
    if (!secondRequest) {
      throw new Error("Expected a resubscribe request");
    }
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    expect(secondRequest.id).not.toBe(firstRequest.id);

    const secondEvent = {
      version: 1,
      sequence: 2,
      type: "welcome",
      payload: {
        cwd: "/tmp/two",
        projectName: "two",
      },
    };
    socket.serverMessage(
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

  it("replays from the last verified cursor after an asynchronous application failure", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const listener = vi
      .fn<(event: OrchestrationDeliveryStreamItem) => void | Promise<void>>()
      .mockRejectedValueOnce(new Error("renderer apply failed"))
      .mockResolvedValue(undefined);
    let appliedSequence = 4;
    const unsubscribe = transport.subscribe(
      (client) =>
        client[WS_METHODS.subscribeOrchestrationDomainEvents]({
          consumerId: "consumer-1",
          appliedSequence,
        }),
      async (event) => {
        await listener(event);
        if (event.type === "batch") {
          const sequence = event.events.at(-1)?.sequence ?? appliedSequence;
          if (sequence > appliedSequence) appliedSequence = sequence;
        }
      },
      { retryDelay: 1 },
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [
          {
            type: "lifecycle",
            route: "direct-unmanaged",
            consumerId: "consumer-1",
            consumerGeneration: 1,
            state: "connecting",
            acknowledgedSequence: 4,
            restartAttempt: 0,
          },
        ],
      }),
    );

    await waitFor(() => {
      const requests = socket.sent.filter((message) => {
        const parsed = JSON.parse(message) as { _tag?: string; id?: string };
        return parsed._tag === "Request" && parsed.id !== firstRequest.id;
      });
      expect(requests).toHaveLength(1);
    });
    const secondRequest = JSON.parse(
      socket.sent.find((message) => {
        const parsed = JSON.parse(message) as { _tag?: string; id?: string };
        return parsed._tag === "Request" && parsed.id !== firstRequest.id;
      }) ?? "{}",
    ) as {
      id: string;
      tag: string;
      payload: { consumerId: string; appliedSequence: number };
    };
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeOrchestrationDomainEvents);
    expect(secondRequest.payload).toEqual({ consumerId: "consumer-1", appliedSequence: 4 });
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: secondRequest.id,
        values: [
          {
            type: "lifecycle",
            route: "direct-unmanaged",
            consumerId: "consumer-1",
            consumerGeneration: 2,
            state: "connecting",
            acknowledgedSequence: 4,
            restartAttempt: 0,
          },
        ],
      }),
    );
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "lifecycle", acknowledgedSequence: 4 }),
    );

    unsubscribe();
    await transport.dispose();
  });

  it("keeps an orchestration stream open while its baseline acknowledgement retries", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    let releaseRetry!: () => void;
    const waitForRetry = new Promise<void>((resolve) => (releaseRetry = resolve));
    const acknowledge = vi
      .fn()
      .mockResolvedValueOnce({ accepted: false, fenced: false, acknowledgedSequence: 0 })
      .mockResolvedValueOnce({ accepted: true, fenced: false, acknowledgedSequence: 10 });
    const unsubscribe = transport.subscribe(
      (client) =>
        client[WS_METHODS.subscribeOrchestrationDomainEvents]({
          consumerId: "consumer-baseline",
          appliedSequence: 0,
        }),
      async (item) => {
        if (item.type !== "recovery") return;
        await recoverAndAcknowledgeDeliveryBaseline({
          recovery: item,
          recover: async () => 10,
          acknowledge,
          sleep: async () => waitForRetry,
        });
      },
      { retryDelay: 1 },
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [
          {
            type: "recovery",
            route: "direct-unmanaged",
            recoveryId: "recovery-1",
            consumerId: "consumer-baseline",
            consumerGeneration: 1,
            serverEpoch: "epoch-1",
            acknowledgedSequence: 0,
            targetSequence: 10,
            reasonCode: "replay_budget_exceeded",
          },
        ],
      }),
    );
    await waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    expect(
      socket.sent.filter((message) => {
        const request = JSON.parse(message) as { tag?: string };
        return request.tag === WS_METHODS.subscribeOrchestrationDomainEvents;
      }),
    ).toHaveLength(1);

    releaseRetry();
    await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2));
    expect(
      socket.sent.filter((message) => {
        const request = JSON.parse(message) as { tag?: string };
        return request.tag === WS_METHODS.subscribeOrchestrationDomainEvents;
      }),
    ).toHaveLength(1);

    unsubscribe();
    await transport.dispose();
  });
});
