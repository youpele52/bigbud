import {
  RemoteBackendAuthority,
  RemoteBackendInstallationFingerprint,
  RemoteBackendMobileDescriptor,
} from "@bigbud/contracts/server/remoteBackendHandshake";
import type {
  RemoteBackendIdentityPin,
  RemoteBackendMobileRevisionSupport,
} from "@bigbud/shared/remoteBackendIdentity";
import * as Schema from "effect/Schema";

import { matchesUsableMobileHost } from "../logic/mobileHostIdentity.logic";

const MAX_HOST_SESSIONS = 32;
const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const IdentityPin = Schema.Struct({
  authority: RemoteBackendAuthority,
  installationFingerprint: RemoteBackendInstallationFingerprint,
});
const Session = Schema.Struct({
  sessionId: NonEmpty,
  sessionToken: NonEmpty,
  backendBaseUrl: NonEmpty,
  scope: Schema.Literals(["read-only", "approve-only", "thread-control"]),
  expiresAt: NonEmpty,
});
const HostEntry = Schema.Struct({
  pin: IdentityPin,
  backendOrigin: NonEmpty,
  session: Session,
});
const HostSessions = Schema.Struct({
  version: Schema.Literal(2),
  entries: Schema.Array(HostEntry),
});

export type MobileHostSessions = typeof HostSessions.Type;

/** No userinfo, paths or credential-bearing query/fragment may become an identity origin. */
export function canonicalMobileHostOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Pure decoding only; reading a collection does not verify a backend or activate a session. */
export function decodeMobileHostSessions(raw: unknown): MobileHostSessions | null {
  try {
    const collection = Schema.decodeUnknownSync(HostSessions)(raw);
    if (collection.entries.length > MAX_HOST_SESSIONS) return null;
    const authorities = new Set<string>();
    for (const entry of collection.entries) {
      const origin = canonicalMobileHostOrigin(entry.backendOrigin);
      if (
        origin !== entry.backendOrigin ||
        canonicalMobileHostOrigin(entry.session.backendBaseUrl) !== origin ||
        !Number.isFinite(Date.parse(entry.session.expiresAt)) ||
        authorities.has(entry.pin.authority.authorityId)
      ) {
        return null;
      }
      authorities.add(entry.pin.authority.authorityId);
    }
    return collection;
  } catch {
    return null;
  }
}

/**
 * Prepare a one-time migration after identity confirmation at the original session origin.
 * This function never deletes the legacy singleton. A caller may remove it only after persisting
 * the successful collection. No runtime currently invokes this helper or forwards credentials.
 */
export function prepareMobileHostSessionMigration(input: {
  readonly collection: MobileHostSessions;
  readonly legacySession: unknown;
  readonly descriptor: RemoteBackendMobileDescriptor;
  readonly confirmedPin: RemoteBackendIdentityPin | null;
  readonly observedOrigin: string;
  readonly support: RemoteBackendMobileRevisionSupport;
  readonly now: number;
}): { readonly status: "migrated" | "rejected"; readonly collection: MobileHostSessions } {
  const reject = { status: "rejected", collection: input.collection } as const;
  const collection = decodeMobileHostSessions(input.collection);
  const origin = canonicalMobileHostOrigin(input.observedOrigin);
  if (!collection || !origin || collection.entries.length >= MAX_HOST_SESSIONS) return reject;
  try {
    const descriptor = Schema.decodeUnknownSync(RemoteBackendMobileDescriptor)(input.descriptor);
    const confirmedPin = Schema.decodeUnknownSync(IdentityPin)(input.confirmedPin);
    if (!matchesUsableMobileHost(descriptor, confirmedPin, input.support)) return reject;
    const session = Schema.decodeUnknownSync(Session)(input.legacySession);
    if (
      canonicalMobileHostOrigin(session.backendBaseUrl) !== origin ||
      !Number.isFinite(input.now) ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= input.now ||
      collection.entries.some(
        (entry) => entry.pin.authority.authorityId === descriptor.authority.authorityId,
      )
    ) {
      return reject;
    }
    const pin = Schema.decodeUnknownSync(IdentityPin)(descriptor);
    return {
      status: "migrated",
      collection: {
        version: 2,
        entries: [
          ...collection.entries,
          { pin, backendOrigin: origin, session: { ...session, backendBaseUrl: origin } },
        ],
      },
    };
  } catch {
    return reject;
  }
}
