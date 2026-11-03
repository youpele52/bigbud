import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { Schema } from "effect";
import { ResourceRead } from "@bigbud/contracts/system-monitor/awareness.ts";
import type { ResourceAwareness } from "./awareness";
import { boundedResourceResponse, readResourceView } from "./awareness.response";

let server: Server | null = null;
let endpoint = "";
let token = "";
let owner: ResourceAwareness | undefined;
let busy = 0;
let generation = 0;
const authorized = (received: string | undefined): boolean => {
  if (!received || !token) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(received);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16384) throw new Error("monitor request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startSystemMonitorAgentBridge(monitor: ResourceAwareness): Promise<void> {
  if (server) return;
  const startingGeneration = ++generation;
  owner = monitor;
  const candidate = createServer((request, response) => {
    const route = request.url;
    const valid =
      (request.method === "GET" && (route === "/snapshot" || route === "/context")) ||
      (request.method === "POST" && (route === "/read" || route === "/rules"));
    if (!valid || !authorized(request.headers.authorization)) {
      response.writeHead(404).end();
      return;
    }
    if (busy >= 4) {
      response.writeHead(503).end(JSON.stringify({ available: false, reason: "monitor busy" }));
      return;
    }
    busy++;
    const requestToken = token;
    const stillAuthorized = () => !!token && token === requestToken;
    request.setTimeout(5000, () => request.destroy());
    void (async () => {
      const input = request.method === "POST" ? await body(request) : {};
      const result =
        route === "/rules"
          ? { available: true, ...(await monitor.mutate(input, stillAuthorized)) }
          : await readResourceView(
              monitor,
              Schema.decodeUnknownSync(ResourceRead)(input),
              route === "/context",
            );
      if (!stillAuthorized()) throw new Error("monitor authorization revoked");
      response
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(boundedResourceResponse(result));
    })()
      .catch((error: unknown) => {
        response.writeHead(503, { "content-type": "application/json" }).end(
          JSON.stringify({
            available: false,
            reason:
              error instanceof Error ? error.message.slice(0, 256) : "desktop monitor unavailable",
          }),
        );
      })
      .finally(() => {
        busy--;
      });
  });
  candidate.headersTimeout = 5000;
  candidate.requestTimeout = 5000;
  try {
    await new Promise<void>((resolve, reject) => {
      candidate.once("error", reject);
      candidate.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    candidate.close();
    throw error;
  }
  if (startingGeneration !== generation) {
    candidate.close();
    return;
  }
  server = candidate;
  const address = candidate.address();
  if (!address || typeof address === "string")
    throw new Error("Monitor agent bridge address unavailable");
  endpoint = `http://127.0.0.1:${address.port}/snapshot`;
}

export function rotateSystemMonitorAgentToken(): { endpoint: string; token: string } | null {
  if (!server || !endpoint) return null;
  token = randomBytes(32).toString("hex");
  return { endpoint, token };
}
export function revokeSystemMonitorAgentToken(): void {
  token = "";
}
export function stopSystemMonitorAgentBridge(): void {
  generation++;
  revokeSystemMonitorAgentToken();
  owner?.stop();
  owner = undefined;
  server?.close();
  server = null;
  endpoint = "";
}
