import { createServer } from "node:http";
import { makeOwnedClient } from "./Client.ts";
import type { V2RuntimeHttpFixture } from "./Runtime.fixture.ts";

/** Real loopback HTTP and pinned SDK, with the observed router bound; not retail-native qualification. */
export async function makeV2BoundedRouterFixture(
  http: Pick<V2RuntimeHttpFixture, "fetch" | "client">,
) {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const result = await http.fetch(`http://127.0.0.1${request.url}`, {
        method: request.method!,
        ...(body ? { body } : {}),
      });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic router unavailable.");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const client = makeOwnedClient({ endpoint, password: "synthetic-only" });
  client.event.subscribe = http.client.event.subscribe;
  return {
    endpoint,
    client,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
