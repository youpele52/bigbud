import {
  REMOTE_BACKEND_HANDSHAKE_REVISION,
  REMOTE_BACKEND_MOBILE_RPC_REVISION,
  type RemoteBackendMobileDescriptor,
} from "@bigbud/contracts/server/remoteBackendHandshake.ts";
import type { RemoteBackendIdentity } from "./authority.ts";

/** Public projection never inherits private identity properties or future record extensions. */
export function remoteMobileDescriptor(
  identity: Pick<RemoteBackendIdentity, "authority" | "installationFingerprint">,
  backendVersion: string,
  mobileCapable: boolean,
): RemoteBackendMobileDescriptor {
  return {
    handshakeRevision: REMOTE_BACKEND_HANDSHAKE_REVISION,
    authority: {
      authorityId: identity.authority.authorityId,
      keyEpoch: identity.authority.keyEpoch,
      keyFingerprint: identity.authority.keyFingerprint,
    },
    installationFingerprint: identity.installationFingerprint,
    backendVersion,
    mobileRpcRevision: REMOTE_BACKEND_MOBILE_RPC_REVISION,
    mobileCapable,
  };
}
