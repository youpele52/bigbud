import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { SystemMonitorBridge } from "./bridge";

const MAX_RESPONSE_BYTES = 32 * 1024;
let server: Server | null = null;
let endpoint = "";
let token = "";
let busy = false;

const authorized = (received: string | undefined): boolean => {
  if (!received || !token) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(received);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export async function startSystemMonitorAgentBridge(monitor: SystemMonitorBridge): Promise<void> {
  if (server) return;
  const candidate = createServer((request, response) => {
    if (
      request.method !== "GET" ||
      request.url !== "/snapshot" ||
      !authorized(request.headers.authorization)
    ) {
      response.writeHead(404).end();
      return;
    }
    if (busy) {
      response.writeHead(503).end(JSON.stringify({ available: false, reason: "monitor busy" }));
      return;
    }
    busy = true;
    const requestToken = token;
    void monitor
      .readSnapshot()
      .then(
        (snapshot) => {
          if (!token || token !== requestToken) {
            response
              .writeHead(503)
              .end(JSON.stringify({ available: false, reason: "desktop monitor unavailable" }));
            return;
          }
          const result = {
            available: true,
            host: {
              hostname: snapshot.hostname,
              osName: snapshot.osName,
              osVersion: snapshot.osVersion,
              architecture: snapshot.architecture,
            },
            sampledAtMs: snapshot.sampledAtMs,
            ageMs: Math.max(0, Date.now() - snapshot.sampledAtMs),
            epoch: snapshot.epoch,
            sequence: snapshot.sequence,
            summaryStatus: snapshot.summaryStatus,
            cpuPercent: snapshot.cpuPercent,
            memoryTotalBytes: snapshot.memoryTotalBytes,
            memoryUsedBytes: snapshot.memoryUsedBytes,
            memoryAvailableBytes: snapshot.memoryAvailableBytes,
            swapTotalBytes: snapshot.swapTotalBytes,
            swapUsedBytes: snapshot.swapUsedBytes,
            networkReceivedBytesPerSecond: snapshot.networkReceivedBytesPerSecond,
            networkTransmittedBytesPerSecond: snapshot.networkTransmittedBytesPerSecond,
            diskCapacityBytes: snapshot.diskCapacityBytes,
          };
          const body = JSON.stringify(result);
          if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES)
            response
              .writeHead(503)
              .end(JSON.stringify({ available: false, reason: "monitor response too large" }));
          else
            response
              .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
              .end(body);
        },
        () =>
          response
            .writeHead(503, { "content-type": "application/json" })
            .end(JSON.stringify({ available: false, reason: "desktop monitor unavailable" })),
      )
      .finally(() => {
        busy = false;
      });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      candidate.once("error", reject);
      candidate.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    candidate.close();
    throw error;
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
  revokeSystemMonitorAgentToken();
  server?.close();
  server = null;
  endpoint = "";
}
