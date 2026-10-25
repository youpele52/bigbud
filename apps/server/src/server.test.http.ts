import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Layer } from "effect";
import { FetchHttpClient, HttpServer } from "effect/unstable/http";
import * as Http from "node:http";

// Match getHttpServerUrl and the test client's IPv4 loopback address. On macOS,
// an IPv6 wildcard listener can share a port with an unrelated IPv4 listener.
export const serverHttpTestLayer = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 })),
);
