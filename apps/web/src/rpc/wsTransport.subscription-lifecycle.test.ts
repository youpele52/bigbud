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
import { isWsSubscriptionListenerFailure } from "./wsTransport";

const sockets: MockWebSocket[] = [];
const transports: WsTransport[] = [];
registerTestHooks(sockets, transports);

describe("WsTransport subscription attempt lifecycle", () => {
  it("cancels a failed listener attempt before replacing it and keeps one active stream", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const listener = vi
      .fn<(value: unknown) => void>()
      .mockImplementationOnce(() => {
        throw new Error("client listener decode failed");
      })
      .mockImplementation(() => undefined);
    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
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
            version: 1,
            sequence: 1,
            type: "welcome",
            payload: { cwd: "/tmp/first", projectName: "first" },
          },
        ],
      }),
    );

    await waitFor(() => {
      const messages = socket.sent.map((message) => JSON.parse(message) as WireMessage);
      expect(messages.some((message) => message._tag === "Interrupt")).toBe(true);
      expect(messages.filter((message) => message._tag === "Request")).toHaveLength(2);
    });

    const messages = socket.sent.map((message) => JSON.parse(message) as WireMessage);
    const firstInterruptIndex = messages.findIndex(
      (message) => message._tag === "Interrupt" && message.requestId === firstRequest.id,
    );
    const replacementIndex = messages.findIndex(
      (message) => message._tag === "Request" && message.id !== firstRequest.id,
    );
    expect(firstInterruptIndex).toBeGreaterThan(-1);
    expect(replacementIndex).toBeGreaterThan(firstInterruptIndex);

    const active = new Set<string>();
    let maximumActive = 0;
    for (const message of messages) {
      if (message._tag === "Request" && message.id) active.add(message.id);
      if (message._tag === "Interrupt" && message.requestId) active.delete(message.requestId);
      maximumActive = Math.max(maximumActive, active.size);
    }
    expect(maximumActive).toBe(1);
    expect(active.size).toBe(1);

    unsubscribe();
    await transport.dispose();
  });

  it("stops deterministic listener replacement after a bounded no-progress budget", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    let failures = 0;
    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      () => {
        throw new Error("deterministic application failure");
      },
      {
        retryDelay: 1,
        shouldRetry: (error) => {
          if (!isWsSubscriptionListenerFailure(error)) return true;
          failures += 1;
          return failures < 3;
        },
      },
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await waitFor(() => {
        const requests = socket.sent
          .map((message) => JSON.parse(message) as WireMessage)
          .filter((message) => message._tag === "Request");
        expect(requests).toHaveLength(attempt);
      });
      const request = socket.sent
        .map((message) => JSON.parse(message) as WireMessage)
        .findLast((message) => message._tag === "Request")!;
      socket.serverMessage(
        JSON.stringify({
          _tag: "Chunk",
          requestId: request.id,
          values: [
            {
              version: 1,
              sequence: attempt,
              type: "welcome",
              payload: { cwd: "/tmp/project", projectName: "project" },
            },
          ],
        }),
      );
    }

    await waitFor(() => expect(failures).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const messages = socket.sent.map((message) => JSON.parse(message) as WireMessage);
    expect(messages.filter((message) => message._tag === "Request")).toHaveLength(3);
    const active = new Set<string>();
    let maximumActive = 0;
    for (const message of messages) {
      if (message._tag === "Request" && message.id) active.add(message.id);
      if (message._tag === "Interrupt" && message.requestId) active.delete(message.requestId);
      maximumActive = Math.max(maximumActive, active.size);
    }
    expect(maximumActive).toBe(1);
    expect(active.size).toBe(0);

    unsubscribe();
    await transport.dispose();
  });
});

interface WireMessage {
  readonly _tag?: string;
  readonly id?: string;
  readonly requestId?: string;
}
