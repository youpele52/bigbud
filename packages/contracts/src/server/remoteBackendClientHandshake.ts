import { Schema } from "effect";

import { PositiveInt, TrimmedNonEmptyString } from "../core/baseSchemas";
import {
  RemoteBackendAuthority,
  RemoteBackendInstallationFingerprint,
} from "./remoteBackendHandshake";

/** Authenticated desktop/client contract; deliberately separate from the public mobile projection. */
export const REMOTE_BACKEND_CLIENT_HANDSHAKE_REVISION = 1;
export const REMOTE_BACKEND_CLIENT_RPC_REVISION = 1;
export const REMOTE_BACKEND_CLIENT_RPC_REVISION_HEADER = "x-bigbud-client-rpc-revision";

export const RemoteBackendClientCapabilities = Schema.Struct({
  persistentTerminals: Schema.Boolean,
  visibleBrowser: Schema.Boolean,
  computerUse: Schema.Boolean,
  hostOsIntegration: Schema.Boolean,
  mobileAccess: Schema.Boolean,
  runtimeUpdates: Schema.Boolean,
});
export type RemoteBackendClientCapabilities = typeof RemoteBackendClientCapabilities.Type;

/** Served only on the authenticated remote client listener, never the provider callback listener. */
export const RemoteBackendClientHandshake = Schema.Struct({
  handshakeRevision: PositiveInt,
  clientRpcRevision: PositiveInt,
  authority: RemoteBackendAuthority,
  installationFingerprint: RemoteBackendInstallationFingerprint,
  backendVersion: TrimmedNonEmptyString,
  capabilities: RemoteBackendClientCapabilities,
});
export type RemoteBackendClientHandshake = typeof RemoteBackendClientHandshake.Type;
