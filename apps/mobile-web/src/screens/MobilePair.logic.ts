import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";
import { compareRemoteBackendMobileIdentity } from "@bigbud/shared/remoteBackendIdentity";

import {
  assessMobileHostDescriptor,
  MOBILE_HOST_REVISION_SUPPORT,
} from "../logic/mobileHostAdmission";
import type { MobileHostCollection } from "../lib/mobileHostCollection";

export function mobilePairingSecret(href: string): string {
  try {
    const hash = new URL(href).hash;
    return hash.startsWith("#secret=") ? decodeURIComponent(hash.slice(8)) : "";
  } catch {
    return "";
  }
}

/** Public approval state is tied to the exact displayed origin and identity, never its name. */
export function mobilePairingConfirmationKey(
  origin: string,
  descriptor: RemoteBackendMobileDescriptor,
) {
  return JSON.stringify([origin, descriptor.authority, descriptor.installationFingerprint]);
}

export function mobilePairingIdentityDecision(input: {
  readonly collection: MobileHostCollection;
  readonly backendOrigin: string;
  readonly descriptor: RemoteBackendMobileDescriptor;
  readonly confirmedFirstSeen: boolean;
}) {
  const atOrigin = input.collection.collection.entries.find(
    (entry) => entry.backendOrigin === input.backendOrigin,
  );
  const admission = assessMobileHostDescriptor(
    input.descriptor,
    atOrigin?.pin ?? null,
    input.confirmedFirstSeen,
  );
  if (!admission.allowed) return admission;
  const byAuthority = input.collection.collection.entries.find(
    (entry) => entry.pin.authority.authorityId === input.descriptor.authority.authorityId,
  );
  if (byAuthority) {
    const reason = compareRemoteBackendMobileIdentity(
      input.descriptor,
      byAuthority.pin,
      MOBILE_HOST_REVISION_SUPPORT,
    );
    if (reason !== "match") return { allowed: false, reason };
  }
  return admission;
}
