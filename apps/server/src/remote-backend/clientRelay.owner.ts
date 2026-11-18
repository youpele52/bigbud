import * as http from "node:http";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { authorizeRemoteClientRequest } from "./clientAuthorization.ts";
import { clientRelayHeaders, clientRelayTarget } from "./clientRelay.headers.ts";
import { makeClientRelayHttpProxy } from "./clientRelay.http.ts";
import { openClientRelaySocket } from "./clientRelay.owner.channel.ts";

/** Private local-backend lease. Only its fresh local capability may reach the owned SSH channels. */
export async function openClientRelayOwner(input: {
  readonly openChannel: (signal: AbortSignal) => Promise<Duplex>;
  readonly allowedOrigins: ReadonlyArray<string>;
}) {
  const token = randomBytes(32).toString("hex");
  const origins = new Set(input.allowedOrigins);
  const sockets = new Set<Duplex>();
  let disposed = false;
  let host: string | undefined;
  const channel = () => {
    if (disposed || sockets.size >= 8) throw new Error("Backend relay connection limit reached.");
    const socket = openClientRelaySocket(input.openChannel);
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: 8,
    maxTotalSockets: 8,
    maxFreeSockets: 2,
    timeout: 60_000,
  });
  agent.createConnection = channel;
  const proxy = makeClientRelayHttpProxy({
    authorize: (request, response) => {
      const origin = request.headers.origin;
      if (
        disposed ||
        request.headers.host !== host ||
        (origin !== undefined && !origins.has(origin))
      ) {
        response?.writeHead(403).end();
        return false;
      }
      if (origin && response) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "Origin");
        response.setHeader(
          "access-control-expose-headers",
          "accept-ranges, content-range, etag, last-modified",
        );
      }
      if (request.method === "OPTIONS" && response && origin) {
        const names = String(request.headers["access-control-request-headers"] ?? "")
          .toLowerCase()
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        if (
          names.some(
            (name) =>
              ![
                "authorization",
                "content-type",
                "x-bigbud-client-rpc-revision",
                "range",
                "if-range",
                "if-none-match",
                "if-modified-since",
              ].includes(name),
          )
        )
          response.writeHead(403).end();
        else
          response
            .writeHead(204, {
              "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
              "access-control-allow-headers": names.join(", "),
              "access-control-max-age": "60",
            })
            .end();
        return false;
      }
      const authorization = authorizeRemoteClientRequest({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(",") : value,
          ]),
        ),
        expectedToken: token,
      });
      if (authorization !== "authorized") {
        response?.writeHead(authorization === "incompatible" ? 426 : 401).end();
        return false;
      }
      return true;
    },
    request: (incoming) =>
      http.request({
        host: "relay.invalid",
        method: incoming.method,
        path: clientRelayTarget(incoming.url),
        headers: clientRelayHeaders(incoming.headers),
        agent,
      }),
  });
  proxy.server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    proxy.server.once("error", reject);
    proxy.server.listen(0, "127.0.0.1", () => {
      proxy.server.removeListener("error", reject);
      resolve();
    });
  }).catch((error) => {
    agent.destroy();
    proxy.close();
    throw error;
  });
  const address = proxy.server.address();
  if (!address || typeof address === "string") {
    agent.destroy();
    proxy.close();
    throw new Error("Backend relay did not bind loopback.");
  }
  host = `127.0.0.1:${address.port}`;
  return {
    baseUrl: `http://${host}`,
    token,
    dispose() {
      if (disposed) return;
      disposed = true;
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      proxy.close();
    },
  };
}
