import {
  RemoteBackendAuthorityId,
  type RemoteBackendMobileDescriptor,
} from "@bigbud/contracts/server/remoteBackendHandshake";
import {
  compareRemoteBackendMobileIdentity,
  supportsRemoteBackendMobileRevision,
  type RemoteBackendIdentityPin,
  type RemoteBackendMobileRevisionSupport,
} from "@bigbud/shared/remoteBackendIdentity";
import * as Schema from "effect/Schema";

export type MobileHostStateArea = "query" | "draft" | "command" | "replay" | "selection";

/** Stable across host renames and backend versions; JSON tuple encoding prevents key collisions. */
export function mobileHostStateKey(
  authorityId: string,
  area: MobileHostStateArea,
  ...parts: ReadonlyArray<string>
): string {
  const authority = Schema.decodeUnknownSync(RemoteBackendAuthorityId)(authorityId);
  return JSON.stringify(["bigbud:mobile-host:v1", authority, area, ...parts]);
}

/**
 * A descriptor alone cannot authorize an existing session. Callers must supply the pin already
 * confirmed for this origin; first contact, rotations and changed installations all fail closed.
 * Session expiry, scopes, revocation and origin binding remain separate admission checks.
 */
export function matchesUsableMobileHost(
  descriptor: RemoteBackendMobileDescriptor,
  pin: RemoteBackendIdentityPin | null,
  support: RemoteBackendMobileRevisionSupport,
): boolean {
  return (
    supportsRemoteBackendMobileRevision(descriptor, support) &&
    compareRemoteBackendMobileIdentity(descriptor, pin, support) === "match" &&
    descriptor.mobileCapable
  );
}
