import { WS_METHODS } from "@bigbud/contracts";
import { expect, it } from "vitest";
import { createWsRpcClient } from "./wsRpcClient";
import type { WsTransport } from "./wsTransport";
import {
  type MockWebSocket,
  createTransport,
  getSocket,
  registerTestHooks,
  waitFor,
} from "./wsTransport.test.helpers";

const sockets: MockWebSocket[] = [];
const transports: WsTransport[] = [];
registerTestHooks(sockets, transports);
const url = "https://example.com/report";

function frames(socket: MockWebSocket) {
  return socket.sent.map(
    (frame) => JSON.parse(frame) as { _tag: string; tag?: string; id?: string },
  );
}

it("interrupts a dispatched URL read over WebSocket without sending its signal as payload", async () => {
  const client = createWsRpcClient(createTransport(transports, "ws://localhost:3020"));
  await waitFor(() => expect(sockets).toHaveLength(1));
  const socket = getSocket(sockets);
  socket.open();
  const controller = new AbortController();
  const pending = client.server.readDocumentUrl({ url }, { signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow();
  await waitFor(() =>
    expect(frames(socket)).toContainEqual(
      expect.objectContaining({
        _tag: "Request",
        tag: WS_METHODS.serverReadDocumentUrl,
        payload: { url },
      }),
    ),
  );
  const requestId = frames(socket).find(
    (frame) => frame.tag === WS_METHODS.serverReadDocumentUrl,
  )!.id;
  controller.abort();
  await rejected;
  await waitFor(() => expect(frames(socket)).toContainEqual({ _tag: "Interrupt", requestId }));
});

it("does not dispatch a URL read cancelled while the transport waits for reconnect", async () => {
  const transport = createTransport(transports, "ws://localhost:3020");
  const client = createWsRpcClient(transport);
  await waitFor(() => expect(sockets).toHaveLength(1));
  const socket = getSocket(sockets);
  socket.open();
  let finish!: () => void;
  (transport as unknown as { reconnectOperation: Promise<void> }).reconnectOperation =
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const controller = new AbortController();
  const pending = client.server.readDocumentUrl({ url }, { signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow();
  controller.abort();
  await rejected;
  finish();
  expect(frames(socket).some((frame) => frame.tag === WS_METHODS.serverReadDocumentUrl)).toBe(
    false,
  );
});
