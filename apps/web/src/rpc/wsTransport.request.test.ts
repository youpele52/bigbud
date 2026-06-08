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

describe("WsTransport unary requests", () => {
  it("sends unary RPC requests and resolves successful exits", async () => {
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

    const socket = getSocket(sockets);
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as {
      _tag: string;
      id: string;
      payload: unknown;
      tag: string;
    };
    expect(requestMessage).toMatchObject({
      _tag: "Request",
      tag: WS_METHODS.serverUpsertKeybinding,
      payload: {
        command: "terminal.toggle",
        key: "ctrl+k",
      },
    });

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: {
            keybindings: [],
            issues: [],
          },
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      keybindings: [],
      issues: [],
    });

    await transport.dispose();
  });
});

describe("WsTransport finite stream requests", () => {
  it("streams finite request events without re-subscribing", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const listener = vi.fn();

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = getSocket(sockets);
    socket.open();

    const requestPromise = transport.requestStream(
      (client) =>
        client[WS_METHODS.gitRunStackedAction]({
          actionId: "action-1",
          cwd: "/repo",
          action: "commit",
        }),
      listener,
    );

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    const progressEvent = {
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    } as const;

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [progressEvent],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await expect(requestPromise).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledWith(progressEvent);
    expect(
      socket.sent.filter((message) => {
        const parsed = JSON.parse(message) as { _tag?: string; tag?: string };
        return parsed._tag === "Request" && parsed.tag === WS_METHODS.gitRunStackedAction;
      }),
    ).toHaveLength(1);
    await transport.dispose();
  });
});
