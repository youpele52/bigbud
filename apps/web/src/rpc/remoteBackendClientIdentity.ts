import {
  RemoteBackendClientHandshake,
  REMOTE_BACKEND_CLIENT_HANDSHAKE_REVISION,
  REMOTE_BACKEND_CLIENT_RPC_REVISION,
} from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import { PositiveInt } from "@bigbud/contracts/core/baseSchemas";
import {
  compareRemoteBackendIdentity,
  type RemoteBackendIdentityPin,
} from "@bigbud/shared/remoteBackendIdentity";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const RevisionHeader = Schema.Struct({
  handshakeRevision: PositiveInt,
  clientRpcRevision: PositiveInt,
});

export type RemoteClientAdmission =
  | { readonly status: "match"; readonly handshake: RemoteBackendClientHandshake }
  | { readonly status: "invalid-handshake" | "unsupported-revision" }
  | { readonly status: Exclude<ReturnType<typeof compareRemoteBackendIdentity>, "match"> };

/** Only an authenticated relay may supply this input; public mobile descriptors cannot admit it.
 * First contact/rotation require their separate explicit trust flow and never establish an owner. */
export function admitRemoteBackendClient(
  input: unknown,
  pin: RemoteBackendIdentityPin | null,
): RemoteClientAdmission {
  const revisions = Schema.decodeUnknownExit(RevisionHeader)(input);
  if (Exit.isFailure(revisions)) return { status: "invalid-handshake" };
  if (
    revisions.value.handshakeRevision !== REMOTE_BACKEND_CLIENT_HANDSHAKE_REVISION ||
    revisions.value.clientRpcRevision !== REMOTE_BACKEND_CLIENT_RPC_REVISION
  )
    return { status: "unsupported-revision" };
  const decoded = Schema.decodeUnknownExit(RemoteBackendClientHandshake)(input);
  if (Exit.isFailure(decoded)) return { status: "invalid-handshake" };
  const status = compareRemoteBackendIdentity(decoded.value, pin);
  return status === "match" ? { status, handshake: decoded.value } : { status };
}
