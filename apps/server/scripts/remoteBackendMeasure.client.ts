/**
 * Owner-socket client for the remote backend measurement (WP-6A): the public handshake and
 * WebSocket RPC over the backend's private Unix socket, authenticated with the account's
 * client token. `ws` is loaded from the installed graph, so the tool has no other dependency.
 */
import { request } from "node:http";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";

export const RPC_DEADLINE_MS = 30_000;
const HANDSHAKE_DEADLINE_MS = 3_000;

export interface BackendEndpoint {
  readonly socketPath: string;
  readonly token: string;
  readonly authorityId: string;
}

export interface WebSocketLike {
  on(event: "message", listener: (data: unknown) => void): void;
  once(event: "open" | "close" | "error", listener: (value?: unknown) => void): void;
  send(data: string): void;
  close(): void;
}
type WebSocketConstructor = new (url: string, options: object) => WebSocketLike;

export function loadWebSocket(graphRoot: string): WebSocketConstructor {
  const required = createRequire(join(graphRoot, "server", "bin.mjs"))("ws") as
    | WebSocketConstructor
    | { WebSocket: WebSocketConstructor };
  return "WebSocket" in required ? required.WebSocket : required;
}

/** One authenticated handshake. Resolves with its round-trip time. */
export function handshake(endpoint: BackendEndpoint): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: endpoint.socketPath,
        path: "/api/remote-backend/handshake",
        headers: { authorization: `Bearer ${endpoint.token}` },
        timeout: HANDSHAKE_DEADLINE_MS,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.once("end", () => {
          try {
            if (res.statusCode !== 200) throw new Error(`handshake status ${res.statusCode}`);
            const body = JSON.parse(raw) as { authority?: { authorityId?: string } };
            if (body.authority?.authorityId !== endpoint.authorityId)
              throw new Error("handshake answered for a different authority");
            resolve(performance.now() - started);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.once("error", reject);
    req.once("timeout", () => req.destroy(new Error("handshake deadline")));
    req.end();
  });
}

export interface RpcClient {
  readonly call: (tag: string, payload: unknown) => Promise<unknown>;
  readonly close: () => void;
}

interface Frame {
  readonly _tag: string;
  readonly requestId?: string | number;
  readonly exit?: { _tag: string; value?: unknown };
  readonly values?: unknown;
}

export async function connectRpc(
  WebSocket: WebSocketConstructor,
  endpoint: BackendEndpoint,
): Promise<RpcClient> {
  const ws = new WebSocket("ws://localhost/ws?clientRpcRevision=1", {
    headers: { authorization: `Bearer ${endpoint.token}` },
    createConnection: () => createConnection(endpoint.socketPath),
    handshakeTimeout: 5_000,
    maxPayload: 256 * 1024 * 1024,
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error as Error));
  });
  let nextId = 0;
  const pending = new Map<string, (exit: NonNullable<Frame["exit"]>) => void>();
  ws.on("message", (data) => {
    for (const line of String(data).split("\n")) {
      if (line.length === 0) continue;
      const parsed = JSON.parse(line) as Frame | Frame[];
      for (const frame of Array.isArray(parsed) ? parsed : [parsed]) {
        if (frame._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
        if (frame._tag === "Chunk")
          ws.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
        if (frame._tag === "Exit" && frame.exit) pending.get(String(frame.requestId))?.(frame.exit);
      }
    }
  });
  ws.once("close", () => {
    for (const resolve of pending.values())
      resolve({ _tag: "Failure", value: "connection closed" });
  });
  return {
    close: () => ws.close(),
    call: (tag, payload) =>
      new Promise((resolve, reject) => {
        const id = String(++nextId);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC deadline ${tag}`));
        }, RPC_DEADLINE_MS);
        pending.set(id, (exit) => {
          clearTimeout(timer);
          pending.delete(id);
          if (exit._tag === "Success") resolve(exit.value);
          else reject(new Error(`RPC ${tag} failed: ${JSON.stringify(exit).slice(0, 500)}`));
        });
        ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      }),
  };
}

/** Poll the handshake until it answers or the deadline passes. Resolves with elapsed ms. */
export async function waitForReady(
  endpoint: BackendEndpoint,
  startedAt: number,
  deadlineMs: number,
  intervalMs = 50,
): Promise<number> {
  let last: unknown;
  while (performance.now() - startedAt < deadlineMs) {
    try {
      await handshake(endpoint);
      return performance.now() - startedAt;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`backend not ready within ${deadlineMs} ms: ${String(last)}`);
}
