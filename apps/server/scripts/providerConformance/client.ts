/**
 * Transports for the provider conformance harness (WP-5D). Both reach the backend's
 * authenticated client Unix socket, the surface that carries D10 setup authority:
 *
 * - `local-socket`: on the backend host, the account's `remote-backend.sock` with its client
 *   token (exactly what the measurement tool uses).
 * - `ssh-relay`: from the laptop, one `ssh <target> exec <node> <relay entry> <authority>` per
 *   HTTP connection; the remote relay injects the token, so none leaves the host.
 *
 * RPC framing is reused from the measurement client by wrapping the `ws` constructor so its
 * connection comes from the chosen transport and its RPC revision can be varied.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";

import {
  connectRpc,
  loadWebSocket,
  type RpcClient,
  type WebSocketLike,
} from "../remoteBackendMeasure.client.ts";

export const CLIENT_RPC_REVISION = 1;
const HANDSHAKE_DEADLINE_MS = 15_000;

export interface HandshakeInfo {
  readonly clientRpcRevision: number;
  readonly backendVersion: string | null;
}

/** What the rows need from a backend: RPC connections at a chosen revision and a handshake. */
export interface ConformanceBackend {
  readonly kind: "local-socket" | "ssh-relay" | "mock";
  readonly connect: (clientRpcRevision?: number) => Promise<RpcClient>;
  readonly handshake: () => Promise<HandshakeInfo>;
}

type WebSocketConstructor = new (url: string, options: object) => WebSocketLike;
type OpenStream = () => Duplex;

function requireWs(moduleDir: string): WebSocketConstructor {
  const required = createRequire(import.meta.url)(moduleDir) as
    | WebSocketConstructor
    | { WebSocket: WebSocketConstructor };
  return "WebSocket" in required ? required.WebSocket : required;
}

/** `ws` from `--ws-module`, else the installed graph, else this checkout's Bun store. */
export function resolveWebSocket(input: {
  readonly wsModule?: string | undefined;
  readonly graphRoot?: string | undefined;
  readonly repoRoot: string;
}): WebSocketConstructor {
  if (input.wsModule) return requireWs(input.wsModule);
  if (input.graphRoot && existsSync(join(input.graphRoot, "server", "bin.mjs")))
    return loadWebSocket(input.graphRoot);
  const store = join(input.repoRoot, "node_modules", ".bun");
  const candidate = existsSync(store)
    ? readdirSync(store).find((entry) => entry.startsWith("ws@8."))
    : undefined;
  if (!candidate) throw new Error("No `ws` module found; pass --ws-module <dir>/node_modules/ws.");
  return requireWs(join(store, candidate, "node_modules", "ws"));
}

/** A stream that also accepts the socket tuning calls `http`/`ws` make on real sockets. */
function socketLike(stream: Duplex): Duplex {
  const target = stream as Duplex & Record<string, unknown>;
  for (const name of ["setNoDelay", "setKeepAlive", "setTimeout", "ref", "unref"]) {
    if (typeof target[name] !== "function") target[name] = () => stream;
  }
  return stream;
}

function withTransport(WebSocket: WebSocketConstructor, open: OpenStream, revision: number) {
  return function TransportWebSocket(url: string, options: object) {
    const revised = url.replace(/clientRpcRevision=\d+/u, `clientRpcRevision=${revision}`);
    return new WebSocket(revised, { ...options, createConnection: () => socketLike(open()) });
  } as unknown as WebSocketConstructor;
}

function handshakeOver(open: OpenStream, token: string | null): Promise<HandshakeInfo> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        createConnection: () => socketLike(open()),
        path: "/api/remote-backend/handshake",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        timeout: HANDSHAKE_DEADLINE_MS,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.once("end", () => {
          try {
            if (res.statusCode !== 200) throw new Error(`handshake status ${res.statusCode}`);
            const body = JSON.parse(raw) as {
              clientRpcRevision?: unknown;
              backendVersion?: unknown;
            };
            resolve({
              clientRpcRevision: Number(body.clientRpcRevision),
              backendVersion: typeof body.backendVersion === "string" ? body.backendVersion : null,
            });
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

function makeBackend(
  kind: ConformanceBackend["kind"],
  WebSocket: WebSocketConstructor,
  open: OpenStream,
  token: string | null,
): ConformanceBackend {
  const endpoint = { socketPath: "", token: token ?? "", authorityId: "" };
  return {
    kind,
    handshake: () => handshakeOver(open, token),
    connect: (revision = CLIENT_RPC_REVISION) =>
      connectRpc(withTransport(WebSocket, open, revision), endpoint),
  };
}

export function localSocketBackend(input: {
  readonly WebSocket: WebSocketConstructor;
  readonly socketPath: string;
  readonly token: string;
}): ConformanceBackend {
  return makeBackend(
    "local-socket",
    input.WebSocket,
    () => createConnection(input.socketPath),
    input.token,
  );
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const SSH_OPTIONS = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
] as const;

export function relayCommand(relayNode: string, relayEntry: string, authorityId: string): string {
  if (!/^[0-9a-f]{32}$/u.test(authorityId)) throw new Error("Invalid backend authority.");
  if (!relayNode.startsWith("/") || !relayEntry.startsWith("/"))
    throw new Error("--relay-node and --relay-entry must be absolute paths on the host.");
  return `exec ${quote(relayNode)} ${quote(relayEntry)} ${quote(authorityId)}`;
}

/** One SSH child per HTTP connection; closing the stream ends the child. */
export function sshRelayBackend(input: {
  readonly WebSocket: WebSocketConstructor;
  readonly sshTarget: string;
  readonly relayNode: string;
  readonly relayEntry: string;
  readonly authorityId: string;
}): ConformanceBackend {
  const command = relayCommand(input.relayNode, input.relayEntry, input.authorityId);
  const open = () => {
    const child = spawn("ssh", [...SSH_OPTIONS, input.sshTarget, "--", command], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    stream.once("close", () => child.kill("SIGTERM"));
    child.once("exit", () => stream.destroy());
    return stream;
  };
  return makeBackend("ssh-relay", input.WebSocket, open, null);
}

/** HTTP status from a rejected WebSocket upgrade (`Unexpected server response: 426`). */
export function rejectedUpgradeStatus(error: unknown): number | null {
  const match = /Unexpected server response: (\d{3})/u.exec(
    error instanceof Error ? error.message : String(error),
  );
  return match ? Number(match[1]) : null;
}
