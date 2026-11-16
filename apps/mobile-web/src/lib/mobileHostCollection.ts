import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";
import { compareRemoteBackendMobileIdentity } from "@bigbud/shared/remoteBackendIdentity";

import {
  assessMobileHostDescriptor,
  MOBILE_HOST_REVISION_SUPPORT,
} from "../logic/mobileHostAdmission";
import {
  canonicalMobileHostOrigin,
  decodeMobileHostSessions,
  prepareMobileHostSessionMigration,
  type MobileHostSessions,
} from "./mobileHostSessions.logic";
import { decodeStoredMobileSession } from "./mobileSession.codec";
import type { StoredMobileSession } from "./mobileSession";

export const MOBILE_HOST_STORAGE_UNCONFIRMED_MESSAGE =
  "Could not confirm this saved host change. This tab keeps its previous connection and drafts. Reload saved hosts before continuing.";

export const MOBILE_HOST_COLLECTION_STORAGE_KEY = "bigbud:mobile-web:hosts:v2";
export interface MobileHostCollection {
  readonly collection: MobileHostSessions;
  /** Renewal provenance requires a reader that understands carried draft payloads. */
  readonly storageVersion?: 3;
  readonly selectedAuthorityId: string | null;
  /** Absent in old envelopes: retain their existing singleton behavior. */
  readonly legacySelected?: boolean;
  /** Explicitly unverified compatibility slot; never a host entry, pin or authority binding. */
  readonly legacySession?: StoredMobileSession | null;
}
export const EMPTY_MOBILE_HOST_COLLECTION: MobileHostCollection = {
  collection: { version: 2, entries: [] },
  selectedAuthorityId: null,
};
type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "getItem" | "setItem">;
function envelope(value: MobileHostCollection) {
  return {
    ...value.collection,
    version: value.storageVersion ?? 2,
    selectedAuthorityId: value.selectedAuthorityId,
    ...(value.legacySelected === undefined ? {} : { legacySelected: value.legacySelected }),
    ...(value.legacySession === undefined ? {} : { legacySession: value.legacySession }),
  };
}
function decode(value: unknown): MobileHostCollection | null {
  const v3 =
    typeof value === "object" && value !== null && "version" in value && value.version === 3;
  const collection = decodeMobileHostSessions(v3 ? { ...value, version: 2 } : value);
  if (!collection || typeof value !== "object" || !value) return null;
  const selected = "selectedAuthorityId" in value ? value.selectedAuthorityId : null;
  if (
    selected !== null &&
    (typeof selected !== "string" ||
      !collection.entries.some((entry) => entry.pin.authority.authorityId === selected))
  )
    return null;
  const legacySelected = "legacySelected" in value ? value.legacySelected : undefined;
  if (legacySelected !== undefined && typeof legacySelected !== "boolean") return null;
  const rawLegacy = "legacySession" in value ? value.legacySession : undefined;
  const legacy =
    rawLegacy === undefined || rawLegacy === null
      ? rawLegacy
      : decodeStoredMobileSession(rawLegacy);
  if (rawLegacy !== undefined && rawLegacy !== null && !legacy) return null;
  return {
    collection,
    ...(v3 ? { storageVersion: 3 as const } : {}),
    selectedAuthorityId: selected,
    ...(legacySelected === undefined ? {} : { legacySelected }),
    ...(legacy === undefined ? {} : { legacySession: legacy }),
  };
}

/** Compare validated storage values, independent of property insertion order in React state. */
export function sameMobileHostCollection(
  a: MobileHostCollection,
  b: MobileHostCollection,
): boolean {
  const left = decode(envelope(a)),
    right = decode(envelope(b));
  return !!left && !!right && JSON.stringify(envelope(left)) === JSON.stringify(envelope(right));
}

/** Reading never activates a credential, creates a pin, deletes legacy data or repairs corruption. */
export function readMobileHostCollection(
  storage: StorageReader,
):
  | { readonly status: "ready"; readonly value: MobileHostCollection }
  | { readonly status: "invalid" | "unavailable" } {
  let raw: string | null;
  try {
    raw = storage.getItem(MOBILE_HOST_COLLECTION_STORAGE_KEY);
  } catch {
    return { status: "unavailable" };
  }
  if (raw === null) return { status: "ready", value: EMPTY_MOBILE_HOST_COLLECTION };
  try {
    const value = decode(JSON.parse(raw));
    return value ? { status: "ready", value } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

/** One atomic value holds credential and selection. Only confirmed writes may switch this tab.
 * A failed readback after setItem leaves durable state unknown; callers must require a reload. */
export function persistMobileHostCollection(
  storage: StorageWriter,
  value: MobileHostCollection,
): boolean {
  const validated = decode(envelope(value));
  if (!validated) return false;
  const raw = JSON.stringify(envelope(validated));
  try {
    storage.setItem(MOBILE_HOST_COLLECTION_STORAGE_KEY, raw);
    return storage.getItem(MOBILE_HOST_COLLECTION_STORAGE_KEY) === raw;
  } catch {
    return false;
  }
}

/** Fresh explicit pairing renews one verified authority; names/versions never merge hosts. */
export function prepareMobileHostPairing(input: {
  readonly current: MobileHostCollection;
  readonly descriptor: RemoteBackendMobileDescriptor;
  readonly backendOrigin: string;
  readonly session: unknown;
  readonly confirmedFirstSeen: boolean;
  readonly now: number;
}):
  | { readonly accepted: true; readonly value: MobileHostCollection }
  | { readonly accepted: false; readonly reason: string } {
  const current = decode(envelope(input.current));
  const origin = canonicalMobileHostOrigin(input.backendOrigin);
  if (!current || !origin || origin !== input.backendOrigin)
    return { accepted: false, reason: "invalid-host-collection" };
  const atOrigin = current.collection.entries.find((entry) => entry.backendOrigin === origin);
  const admission = assessMobileHostDescriptor(
    input.descriptor,
    atOrigin?.pin ?? null,
    input.confirmedFirstSeen,
  );
  if (!admission.allowed) return { accepted: false, reason: admission.reason };
  const authorityId = input.descriptor.authority.authorityId;
  const existing = current.collection.entries.find(
    (entry) => entry.pin.authority.authorityId === authorityId,
  );
  if (existing) {
    const verdict = compareRemoteBackendMobileIdentity(
      input.descriptor,
      existing.pin,
      MOBILE_HOST_REVISION_SUPPORT,
    );
    if (verdict !== "match") return { accepted: false, reason: verdict };
  }
  const withoutRenewed = {
    version: 2 as const,
    entries: current.collection.entries.filter(
      (entry) => entry.pin.authority.authorityId !== authorityId,
    ),
  };
  const migrated = prepareMobileHostSessionMigration({
    collection: withoutRenewed,
    legacySession: input.session,
    descriptor: input.descriptor,
    confirmedPin: input.descriptor,
    observedOrigin: origin,
    support: MOBILE_HOST_REVISION_SUPPORT,
    now: input.now,
  });
  if (migrated.status !== "migrated")
    return { accepted: false, reason: "invalid-or-expired-session" };
  const replacement = migrated.collection.entries.find(
    (entry) => entry.pin.authority.authorityId === authorityId,
  );
  if (
    existing &&
    replacement &&
    existing.session.sessionId === replacement.session.sessionId &&
    existing.session.sessionToken !== replacement.session.sessionToken
  )
    return { accepted: false, reason: "replacement-session-id-required" };
  return {
    accepted: true,
    value: {
      ...current,
      collection: migrated.collection,
      selectedAuthorityId: authorityId,
      legacySelected: false,
    },
  };
}
