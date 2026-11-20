import * as http from "node:http";
import type { Duplex } from "node:stream";
import { clientRelayHeaders, clientRelayTarget } from "./clientRelay.headers.ts";
import { makeClientRelayHttpProxy } from "./clientRelay.http.ts";

/** One authenticated UDS surface; no TCP port, daemon, provider or installation channel. */
export function serveClientRelayStream(input: {
  readonly stream: Duplex;
  readonly socketPath: string;
  readonly token: string;
}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 });
  const proxy = makeClientRelayHttpProxy({
    request: (incoming) => {
      const headers = clientRelayHeaders(incoming.headers);
      headers.authorization = `Bearer ${input.token}`;
      return http.request({
        socketPath: input.socketPath,
        method: incoming.method,
        path: clientRelayTarget(incoming.url),
        headers,
        agent,
      });
    },
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    agent.destroy();
    proxy.close();
    input.stream.destroy();
  };
  input.stream.once("error", close);
  input.stream.once("close", close);
  proxy.server.emit("connection", input.stream);
  return { close };
}
