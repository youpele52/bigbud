/**
 * D10 setup authority for runtime updates (WP-4C), enforced on the backend boundary.
 *
 * Setup authority is exactly: a remote-mode backend, a WebSocket accepted on the authenticated
 * client Unix socket router (the SSH-relayed laptop; its bearer token was checked by
 * `authorizeRemoteClientRequest`). That router opts in explicitly; the local desktop/web router
 * never grants it. Paired mobile clients are viewers: they connect through the separate mobile
 * socket, router and `MobileWsRpcGroup`, which contain no update RPCs, and even a forged header
 * cannot match the per-process capability below.
 *
 * Setup authority is not D9 interruption consent; see `runtimeUpdate.consent.ts`.
 */
import { randomUUID } from "node:crypto";
import { Effect, Layer, Option } from "effect";
import { Headers } from "effect/unstable/http";
import { RemoteRuntimeUpdateSetupAuthority } from "@bigbud/contracts/server/rpc.remoteBackendUpdate.ts";
import { runtimeUpdateError } from "./runtimeUpdate.states.ts";

const SETUP_AUTHORITY_HEADER = "x-bigbud-remote-runtime-update-authority";

export interface RuntimeUpdateConnection {
  /** Server runtime mode (`ServerConfig.mode`). */
  readonly mode: string;
  /** Set only by the remote client Unix socket router (`server.remote.routes.ts`). */
  readonly remoteClientRouter: boolean;
  /** The connection passed the router's client authorization. */
  readonly authorized: boolean;
}

/** Pure rule: only an authenticated client-socket connection on a remote backend qualifies. */
export function grantsRuntimeUpdateSetupAuthority(connection: RuntimeUpdateConnection): boolean {
  return connection.mode === "remote" && connection.remoteClientRouter && connection.authorized;
}

/**
 * One capability per route instance. `authorizeHeaders` always strips a client-supplied header
 * first, then stamps the capability only when the connection qualifies; the RPC middleware layer
 * denies every update RPC without it.
 */
export function makeRuntimeUpdateSetupAuthority(capability: string = randomUUID()) {
  const authorizeHeaders = (
    headers: Headers.Headers,
    connection: RuntimeUpdateConnection,
  ): Headers.Headers => {
    const sanitized = Headers.remove(headers, SETUP_AUTHORITY_HEADER);
    return grantsRuntimeUpdateSetupAuthority(connection)
      ? Headers.set(sanitized, SETUP_AUTHORITY_HEADER, capability)
      : sanitized;
  };
  const layer = Layer.succeed(RemoteRuntimeUpdateSetupAuthority, (effect, options) =>
    Option.contains(Headers.get(options.headers, SETUP_AUTHORITY_HEADER), capability)
      ? effect
      : Effect.fail(
          runtimeUpdateError(
            "unauthorized",
            "Runtime updates require setup authority from the SSH-relayed laptop client.",
          ),
        ),
  );
  return { authorizeHeaders, layer };
}
