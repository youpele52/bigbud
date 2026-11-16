import {
  allowsMobileCredentialOrigin,
  currentMobileDeploymentPolicy,
} from "../logic/mobileDeploymentPolicy";
import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";

import {
  assessMobileHostDescriptor,
  fetchMobileHostDescriptor,
} from "../logic/mobileHostAdmission";
import { canonicalMobileHostOrigin, type MobileHostSessions } from "./mobileHostSessions.logic";
import type { StoredMobileSession } from "./mobileSession";

export type MobileHostEntry = MobileHostSessions["entries"][number];

const REASONS: Record<string, string> = {
  "unsupported-revision": "This host needs a compatible bigbud update before mobile can connect.",
  "authority-changed":
    "This address now belongs to a different backend. Pair it again before connecting.",
  "duplicate-authority":
    "The backend installation changed. Resolve its identity before pairing again.",
  "key-rotated": "This backend key changed. Confirm it through a fresh pairing link.",
  "key-mismatch":
    "This backend key does not match its saved identity. Pair it again before connecting.",
  "mobile-unavailable": "Mobile access is not enabled and ready on this host.",
  "identity-unavailable":
    "This paired host no longer provides backend identity. Retry or pair again.",
  "expired-session": "This host session expired. Pair this host again.",
  "foreign-origin": "Open this host’s own mobile app. This origin cannot use its credentials.",
  "origin-mismatch": "This session does not belong to the selected backend origin.",
};

export class MobileHostAdmissionRejectedError extends Error {
  constructor(readonly reason: string) {
    super(REASONS[reason] ?? "This backend identity could not be verified. Pair it again.");
    this.name = "MobileHostAdmissionRejectedError";
  }
}

/** Repeated before every credential-bearing connection, never only on initial host selection. */
export async function verifyMobileHostConnection(
  host: MobileHostEntry,
  options: { readonly signal?: AbortSignal; readonly fetch?: typeof fetch } = {},
): Promise<RemoteBackendMobileDescriptor> {
  if (!allowsMobileCredentialOrigin(currentMobileDeploymentPolicy(), host.backendOrigin))
    throw new MobileHostAdmissionRejectedError("foreign-origin");
  if (canonicalMobileHostOrigin(host.session.backendBaseUrl) !== host.backendOrigin) {
    throw new MobileHostAdmissionRejectedError("origin-mismatch");
  }
  const checkExpiry = () => {
    const expiry = Date.parse(host.session.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      throw new MobileHostAdmissionRejectedError("expired-session");
    }
  };
  checkExpiry();
  const result = await fetchMobileHostDescriptor(host.backendOrigin, options);
  options.signal?.throwIfAborted();
  if (result.status !== "descriptor")
    throw new MobileHostAdmissionRejectedError("identity-unavailable");
  const admission = assessMobileHostDescriptor(result.descriptor, host.pin, false);
  if (!admission.allowed) throw new MobileHostAdmissionRejectedError(admission.reason);
  checkExpiry();
  return result.descriptor;
}

/** Only callers that completed pinned HTTPS admission may expose this runtime session. */
export function admittedMobileHostSession(host: MobileHostEntry): StoredMobileSession {
  return {
    ...host.session,
    websocketUrl: `${host.backendOrigin.replace(/^https:/, "wss:")}/mobile-ws`,
  };
}
