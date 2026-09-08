import { WS_METHODS, type ServerConfigStreamEvent } from "@bigbud/contracts";
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

describe("WsTransport server config wire decoding", () => {
  it("normalizes the observed snapshot newline variant before delivering it to a client", async () => {
    const transport = createTransport(transports, "ws://localhost:3020");
    const listener = vi.fn<(event: ServerConfigStreamEvent) => void>();
    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerConfig]({}),
      listener,
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket(sockets);
    socket.open();
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    const request = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: request.id,
        values: [
          {
            version: 1,
            type: "snapshot\n",
            config: {
              cwd: "/workspace",
              storage: { notesDir: "/notes", kanbanDir: "/kanban" },
              keybindingsConfigPath: "/keybindings.json",
              keybindings: [],
              issues: [],
              providers: [],
              discovery: { agents: [], skills: [] },
              availableEditors: [],
              observability: {
                logsDirectoryPath: "/logs",
                localTracingEnabled: false,
                otlpTracesEnabled: false,
                otlpMetricsEnabled: false,
              },
              settings: {
                enableAssistantStreaming: true,
                enableThinkingStreaming: false,
                threadRetentionPolicy: "never",
              },
            },
          },
        ],
      }),
    );

    await waitFor(() =>
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "snapshot" })),
    );

    unsubscribe();
    await transport.dispose();
  });
});
