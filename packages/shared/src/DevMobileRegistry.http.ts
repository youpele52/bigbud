import { request, type IncomingMessage, type ServerResponse } from "node:http";

import type { MobileDevRecord } from "@bigbud/shared/DevMobileRegistry";

export const MOBILE_DEV_HEALTH_PATH = "/__bigbud/mobile-dev-health";
export const MOBILE_DEV_DISCOVERY_PATH = "/__bigbud/mobile-dev";
export const MOBILE_DEV_LOOPBACK_HOST = "127.0.0.1";

export function isLocalDevRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") {
    return false;
  }
  const host = req.headers.host;
  if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  // A remote website must not use the loopback endpoint for discovery.
  return !req.headers.origin || req.headers.origin === `http://${host}`;
}

export function sendDevJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

export function probeMobileListener(
  record: MobileDevRecord,
  timeoutMs = 250,
  hostname: "127.0.0.1" | "::1" = MOBILE_DEV_LOOPBACK_HOST,
): Promise<boolean> {
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let body = "";
    const req = request({
      hostname,
      port: record.port,
      path: MOBILE_DEV_HEALTH_PATH,
      method: "GET",
      agent: false,
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(healthy: boolean) {
      clearTimeout(timer);
      req.destroy();
      resolve(healthy);
    }
    req.on("error", () => finish(false));
    req.on("response", (res) => {
      if (res.statusCode !== 200) return finish(false);
      res.setEncoding("utf8");
      res.on("error", () => finish(false));
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 1024) finish(false);
      });
      res.on("end", () => {
        try {
          const value: unknown = JSON.parse(body);
          finish(
            typeof value === "object" &&
              value !== null &&
              "nonce" in value &&
              value.nonce === record.nonce,
          );
        } catch {
          finish(false);
        }
      });
    });
    req.end();
  });
}

export async function verifyMobileListenerUrl(
  record: MobileDevRecord,
  timeoutMs = 250,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  if (await probeMobileListener(record, Math.floor(timeoutMs / 2))) {
    return `http://${MOBILE_DEV_LOOPBACK_HOST}:${record.port}`;
  }
  if (await probeMobileListener(record, deadline - Date.now(), "::1")) {
    return `http://[::1]:${record.port}`;
  }
  return null;
}
