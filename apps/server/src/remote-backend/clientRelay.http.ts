import * as http from "node:http";
import type { Duplex } from "node:stream";
import { clientRelayHeaders } from "./clientRelay.headers.ts";

/** HTTP over one SSH-owned stdio stream. This never listens on a port or starts a backend. */
export function makeClientRelayHttpProxy(input: {
  readonly request: (incoming: http.IncomingMessage) => http.ClientRequest;
  readonly authorize?: (incoming: http.IncomingMessage, outgoing?: http.ServerResponse) => boolean;
}) {
  const pending = new Set<http.ClientRequest>();
  const peers = new Set<Duplex>();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const request of pending) request.destroy();
    for (const peer of peers) peer.destroy();

    server.close();
  };
  const server = http.createServer(
    { maxHeaderSize: 16 * 1024, requestTimeout: 120_000, headersTimeout: 15_000 },
    (incoming, outgoing) => {
      if (input.authorize && !input.authorize(incoming, outgoing)) return;
      if (closed || pending.size >= 16 || incoming.method === "CONNECT") {
        outgoing.writeHead(503).end();
        return;
      }
      let upstream: http.ClientRequest;
      try {
        upstream = input.request(incoming);
      } catch {
        outgoing.writeHead(400).end();
        return;
      }
      pending.add(upstream);
      upstream.once("close", () => pending.delete(upstream));
      upstream.setTimeout(60_000, () => upstream.destroy());
      incoming.once("aborted", () => upstream.destroy());
      outgoing.once("close", () => {
        if (!outgoing.writableFinished) upstream.destroy();
      });
      upstream.once("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      upstream.once("response", (response) => {
        outgoing.writeHead(response.statusCode ?? 502, clientRelayHeaders(response.headers));
        response.once("error", () => outgoing.destroy());
        response.pipe(outgoing);
      });
      let bytes = 0;
      incoming.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) {
          upstream.destroy();
          incoming.destroy();
        }
      });
      incoming.pipe(upstream);
    },
  );
  server.on("connection", (socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
  });
  server.on("upgrade", (incoming, downstream, head) => {
    if (input.authorize && !input.authorize(incoming)) {
      downstream.destroy();
      return;
    }
    let upstream: http.ClientRequest;
    try {
      if (
        incoming.method !== "GET" ||
        new URL(incoming.url ?? "", "http://relay.invalid").pathname !== "/ws" ||
        incoming.headers.upgrade?.toLowerCase() !== "websocket" ||
        pending.size >= 16
      )
        throw new Error("Unsupported upgrade.");
      upstream = input.request(incoming);
      upstream.setHeader("connection", "Upgrade");
      upstream.setHeader("upgrade", "websocket");
    } catch {
      downstream.destroy();
      return;
    }
    pending.add(upstream);
    upstream.once("close", () => pending.delete(upstream));
    upstream.setTimeout(15_000, () => upstream.destroy());
    downstream.once("close", () => upstream.destroy());
    upstream.once("error", () => downstream.destroy());
    upstream.once("response", () => downstream.destroy());
    upstream.once("upgrade", (response, peer, received) => {
      if (response.statusCode !== 101) {
        peer.destroy();
        downstream.destroy();
        return;
      }
      peer.setTimeout(0);
      peers.add(peer);
      peer.once("close", () => {
        peers.delete(peer);
        downstream.destroy();
      });
      downstream.once("close", () => peer.destroy());
      peer.once("error", () => downstream.destroy());
      const headers = clientRelayHeaders(response.headers);
      downstream.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
          Object.entries(headers)
            .map(([key, value]) => `${key}: ${value}\r\n`)
            .join("") +
          "\r\n",
      );
      if (head.length) peer.write(head);
      if (received.length) downstream.write(received);
      downstream.pipe(peer).pipe(downstream);
    });
    upstream.end();
  });
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  return { server, close };
}
