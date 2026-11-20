import {
  REMOTE_BACKEND_HANDSHAKE_REVISION,
  type RemoteBackendIdentityVerdict,
  type RemoteBackendMobileDescriptor,
} from "@bigbud/contracts/server/remoteBackendHandshake";

/** Public identity only. Credentials and display names never participate in pin comparison. */
export type RemoteBackendIdentityPin = Pick<
  RemoteBackendMobileDescriptor,
  "authority" | "installationFingerprint"
>;

export interface RemoteBackendMobileRevisionSupport {
  readonly minimumMobileRpcRevision: number;
  readonly maximumMobileRpcRevision: number;
}

/** Inspect revisions before interpreting identity fields from a newer descriptor shape. */
export function supportsRemoteBackendMobileRevision(
  descriptor: Pick<RemoteBackendMobileDescriptor, "handshakeRevision" | "mobileRpcRevision">,
  support: RemoteBackendMobileRevisionSupport,
): boolean {
  const { minimumMobileRpcRevision: minimum, maximumMobileRpcRevision: maximum } = support;
  return (
    Number.isSafeInteger(minimum) &&
    minimum > 0 &&
    Number.isSafeInteger(maximum) &&
    maximum >= minimum &&
    descriptor.handshakeRevision === REMOTE_BACKEND_HANDSHAKE_REVISION &&
    Number.isSafeInteger(descriptor.mobileRpcRevision) &&
    descriptor.mobileRpcRevision >= minimum &&
    descriptor.mobileRpcRevision <= maximum
  );
}

/**
 * Compare an already decoded descriptor with the pin selected for its origin, in contract order.
 * This neither creates a pin nor authorizes pairing/writes. In particular, first-seen still needs
 * revision validation and explicit pairing consent; a matching pin does not enable mobile access.
 */
export function compareRemoteBackendMobileIdentity(
  descriptor: RemoteBackendMobileDescriptor,
  pin: RemoteBackendIdentityPin | null,
  support: RemoteBackendMobileRevisionSupport,
): RemoteBackendIdentityVerdict {
  if (pin === null) return "first-seen";
  if (!supportsRemoteBackendMobileRevision(descriptor, support)) return "unsupported-revision";
  return compareRemoteBackendIdentity(descriptor, pin);
}

/** Shared identity order for already decoded, revision-compatible authenticated descriptors.
 * This never trusts a first contact or accepts rotation; the owning protocol gates revisions. */
export function compareRemoteBackendIdentity(
  descriptor: RemoteBackendIdentityPin,
  pin: RemoteBackendIdentityPin | null,
): Exclude<RemoteBackendIdentityVerdict, "unsupported-revision"> {
  if (pin === null) return "first-seen";
  if (descriptor.authority.authorityId !== pin.authority.authorityId) return "authority-changed";
  if (descriptor.installationFingerprint !== pin.installationFingerprint)
    return "duplicate-authority";

  const { keyEpoch, keyFingerprint } = descriptor.authority;
  if (keyEpoch === pin.authority.keyEpoch && keyFingerprint === pin.authority.keyFingerprint) {
    return "match";
  }
  return keyEpoch > pin.authority.keyEpoch && keyFingerprint !== pin.authority.keyFingerprint
    ? "key-rotated"
    : "key-mismatch";
}
