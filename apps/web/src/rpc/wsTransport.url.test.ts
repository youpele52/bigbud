import { describe, expect, it } from "vitest";

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

describe("WsTransport URL normalization", () => {
  it("normalizes root websocket urls to /ws and preserves query params", async () => {
    const transport = createTransport(transports, "ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket(sockets).url).toBe("ws://localhost:3020/ws?token=secret-token");
    await transport.dispose();
  });

  it("uses wss when falling back to an https page origin", async () => {
    Object.assign(window.location, {
      origin: "https://app.example.com",
      hostname: "app.example.com",
      port: "",
      protocol: "https:",
    });

    const transport = createTransport(transports);

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket(sockets).url).toBe("wss://app.example.com/ws");
    await transport.dispose();
  });
});
