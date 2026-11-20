import { timingSafeEqual } from "node:crypto";

import {
  REMOTE_BACKEND_CLIENT_RPC_REVISION,
  REMOTE_BACKEND_CLIENT_RPC_REVISION_HEADER,
} from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";

export const REMOTE_CLIENT_HANDSHAKE_PATH = "/api/remote-backend/handshake";
export const REMOTE_BACKEND_MAX_CLIENT_TOKEN_BYTES = 4096;

export type RemoteClientAuthorization = "authorized" | "unauthorized" | "incompatible";

function matchesCredential(candidate: string | null | undefined, expected: string | undefined) {
  if (!candidate || !expected) return false;
  if (
    Buffer.byteLength(candidate) > REMOTE_BACKEND_MAX_CLIENT_TOKEN_BYTES ||
    Buffer.byteLength(expected) > REMOTE_BACKEND_MAX_CLIENT_TOKEN_BYTES
  )
    return false;
  const supplied = Buffer.from(candidate);
  const secret = Buffer.from(expected);
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}

/** All remote HTTP routes share this boundary, including attachments and file previews. */
export function authorizeRemoteClientRequest(input: {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly expectedToken: string | undefined;
}): RemoteClientAuthorization {
  let url: URL;
  try {
    url = new URL(input.url, "http://remote.invalid");
  } catch {
    return "unauthorized";
  }
  const websocket =
    input.method === "GET" &&
    url.pathname === "/ws" &&
    input.headers.upgrade?.toLowerCase() === "websocket";
  const authorization = input.headers.authorization;
  const bearer = authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (authorization !== undefined && bearer === undefined) return "unauthorized";
  const queryTokens = websocket ? url.searchParams.getAll("token") : [];
  if (queryTokens.length > 1) return "unauthorized";
  const queryToken = queryTokens[0];
  if (bearer !== undefined && queryToken !== undefined && bearer !== queryToken)
    return "unauthorized";
  if (!matchesCredential(bearer ?? queryToken, input.expectedToken)) return "unauthorized";
  if (input.method === "GET" && url.pathname === REMOTE_CLIENT_HANDSHAKE_PATH) return "authorized";
  const headerRevision = input.headers[REMOTE_BACKEND_CLIENT_RPC_REVISION_HEADER];
  const queryRevisions = websocket ? url.searchParams.getAll("clientRpcRevision") : [];
  if (queryRevisions.length > 1) return "incompatible";
  const queryRevision = queryRevisions[0];
  if (
    headerRevision !== undefined &&
    queryRevision !== undefined &&
    headerRevision !== queryRevision
  )
    return "incompatible";
  return (headerRevision ?? queryRevision) === String(REMOTE_BACKEND_CLIENT_RPC_REVISION)
    ? "authorized"
    : "incompatible";
}
