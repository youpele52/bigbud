import {
  REMOTE_BACKEND_CLIENT_RPC_REVISION,
  REMOTE_BACKEND_CLIENT_RPC_REVISION_HEADER,
} from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import type { RemoteBackendRelayLease } from "@bigbud/contracts/server/remoteBackendRelay.ts";
import type { BoundBackendHttpEndpoint } from "./backendScope.state";
import type { AuthenticatedRemoteEndpoint } from "./remoteBackendClientEndpoint";

/** Mirrors the server's authenticated client handshake route. */
export const REMOTE_BACKEND_HANDSHAKE_PATH = "/api/remote-backend/handshake";

type Lease = Pick<RemoteBackendRelayLease, "baseUrl" | "localCredential">;

/** Every relay HTTP request (attachments, previews, metadata) carries these headers. */
export function leaseHttpEndpoint(lease: Lease): BoundBackendHttpEndpoint {
  return Object.freeze({
    origin: new URL(lease.baseUrl).origin,
    headers: Object.freeze({
      authorization: `Bearer ${lease.localCredential}`,
      [REMOTE_BACKEND_CLIENT_RPC_REVISION_HEADER]: String(REMOTE_BACKEND_CLIENT_RPC_REVISION),
    }),
  });
}

/** Browsers cannot set headers on a WebSocket upgrade, so the relay accepts the lease credential
 * and revision as query parameters on `/ws` only (`clientAuthorization.ts`). */
export function leaseWebsocketUrl(lease: Lease): string {
  const url = new URL("/ws", lease.baseUrl);
  url.protocol = "ws:";
  url.searchParams.set("token", lease.localCredential);
  url.searchParams.set("clientRpcRevision", String(REMOTE_BACKEND_CLIENT_RPC_REVISION));
  return url.toString();
}

export class RelayLeaseUnreachableError extends Error {
  readonly _tag = "RelayLeaseUnreachableError";
  constructor(readonly status: number | null) {
    super("The remote backend relay lease is unreachable.");
    this.name = "RelayLeaseUnreachableError";
  }
}

/** Reads the authenticated handshake through the lease. Credentials never reach error text. */
export async function readLeaseEndpoint(
  lease: Lease,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthenticatedRemoteEndpoint> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(REMOTE_BACKEND_HANDSHAKE_PATH, lease.baseUrl), {
      headers: { authorization: `Bearer ${lease.localCredential}` },
      cache: "no-store",
      credentials: "omit",
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new RelayLeaseUnreachableError(null);
  }
  if (!response.ok) throw new RelayLeaseUnreachableError(response.status);
  let handshake: unknown;
  try {
    handshake = await response.json();
  } catch {
    // Admission rejects a malformed handshake with a typed "invalid-handshake" refusal.
    handshake = null;
  }
  return { websocketUrl: leaseWebsocketUrl(lease), handshake };
}
