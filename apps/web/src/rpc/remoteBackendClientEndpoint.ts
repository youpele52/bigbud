import type { RemoteBackendClientHandshake } from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import type { RemoteBackendIdentityPin } from "@bigbud/shared/remoteBackendIdentity";
import * as Effect from "effect/Effect";
import {
  admitRemoteBackendClient,
  type RemoteClientAdmission,
} from "./remoteBackendClientIdentity";

export interface AuthenticatedRemoteEndpoint {
  readonly websocketUrl: string;
  readonly handshake: unknown;
}
export type RemoteEndpointResolver = (signal: AbortSignal) => Promise<AuthenticatedRemoteEndpoint>;
export type RemoteClientRefusal =
  | Exclude<RemoteClientAdmission["status"], "match">
  | "invalid-endpoint";

export class RemoteBackendClientRefused extends Error {
  constructor(readonly status: RemoteClientRefusal) {
    super(`Remote backend client admission refused: ${status}`);
    this.name = "RemoteBackendClientRefused";
  }
}

class RemoteBackendEndpointUnavailable extends Error {
  readonly _tag = "RemoteBackendEndpointUnavailable";
  constructor() {
    super("The authenticated remote backend endpoint is unavailable.");
  }
}

function validateWebsocketUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol === "ws:" && !["127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error("invalid endpoint");
    return url.toString();
  } catch {
    // Never echo a credential-bearing endpoint into diagnostics.
    throw new RemoteBackendClientRefused("invalid-endpoint");
  }
}

/** The resolver owns an authenticated relay and binds its descriptor to the returned endpoint.
 * Every invocation has a bounded/cancellable budget; this function never fetches a public descriptor. */
export async function resolvePinnedRemoteEndpoint(
  resolve: RemoteEndpointResolver,
  pin: RemoteBackendIdentityPin,
  signal: AbortSignal,
): Promise<{ readonly websocketUrl: string; readonly handshake: RemoteBackendClientHandshake }> {
  signal.throwIfAborted();
  const endpoint = await Effect.runPromise(
    Effect.tryPromise({
      try: resolve,
      catch: () => new RemoteBackendEndpointUnavailable(),
    }).pipe(Effect.timeout("15 seconds")),
    { signal },
  );
  signal.throwIfAborted();
  const admission = admitRemoteBackendClient(endpoint.handshake, pin);
  if (admission.status !== "match") throw new RemoteBackendClientRefused(admission.status);
  return {
    websocketUrl: validateWebsocketUrl(endpoint.websocketUrl),
    handshake: admission.handshake,
  };
}
