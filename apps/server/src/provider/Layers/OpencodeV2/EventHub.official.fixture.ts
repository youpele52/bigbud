import { createServer, type ServerResponse } from "node:http";
import { makeV2Client } from "./Client.ts";
import { deferred } from "./Test.fixtures.ts";

/** Disposable loopback HTTP SSE through the installed Promise client, without replacing its subscriber/parser. */
export async function officialV2EventFixture() {
  const connected = deferred<ServerResponse>();
  const responses = new Set<ServerResponse>();
  let requests = 0,
    closed = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.flushHeaders();
    responses.add(response);
    response.on("close", () => {
      closed++;
      responses.delete(response);
    });
    connected.resolve(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SSE fixture address unavailable.");
  const transport = "/synthetic/official-sse/service.json";
  const client = makeV2Client({
    endpoint: `http://127.0.0.1:${address.port}`,
    sharedTransport: transport,
  });
  return {
    client,
    transport,
    connected: connected.promise,
    get requests() {
      return requests;
    },
    get closed() {
      return closed;
    },
    async close() {
      for (const response of responses) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function officialSseFrame(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`;
}
export const officialSseMarker = officialSseFrame({
  id: "evt_connected",
  type: "server.connected",
  data: { version: "2.0.26" },
});
