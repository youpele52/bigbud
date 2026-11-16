import type { StoredMobileSession } from "./mobileSession";
import { getMobileSessionAuthority } from "./mobileSessionAuthority";
import {
  mobileComposerDraftKey,
  mobileComposerDraftSessionPrefix,
  makeMobileComposerDraftIdentity,
  type MobileComposerDraftSessionIdentity,
} from "./mobileComposerDraft.identity";
import {
  readMobileComposerDraft,
  forgetMobileComposerDraftsForSession,
} from "./mobileComposerDraft";
import { getMobileComposerDraftStorage } from "./mobileComposerDraft.storage";

const RECEIPT_PREFIX = "bigbud:mobile-composition:migration:v1:";
function receiptKey(session: MobileComposerDraftSessionIdentity) {
  return (
    RECEIPT_PREFIX +
    mobileComposerDraftSessionPrefix({
      backendBaseUrl: session.backendBaseUrl,
      sessionId: session.sessionId,
    })
  );
}
export type MobileDraftMigrationResult =
  | { readonly ok: true; readonly copied: number }
  | {
      readonly ok: false;
      readonly issue: "unverified" | "unavailable" | "malformed" | "foreign-claim" | "too-many";
    };

/** Called after confirmed identity AND durable collection commit. No dispatch or original deletion. */
export function migrateMobileSessionDrafts(
  session: StoredMobileSession,
): MobileDraftMigrationResult {
  const authorityId = getMobileSessionAuthority(session);
  if (!authorityId) return { ok: false, issue: "unverified" };
  const storage = getMobileComposerDraftStorage();
  if (!storage) return { ok: false, issue: "unavailable" };
  try {
    const claim = storage.getItem(receiptKey(session));
    if (claim !== null && claim !== authorityId) return { ok: false, issue: "foreign-claim" };
    if (storage.length > 4096) return { ok: false, issue: "too-many" };
    const prefix = `${mobileComposerDraftSessionPrefix({ backendBaseUrl: session.backendBaseUrl, sessionId: session.sessionId })}:`;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
      if (keys.length > 512) return { ok: false, issue: "too-many" };
    }
    const pending: { key: string; raw: string }[] = [];
    let bytes = 0;
    for (const key of keys) {
      const threadId = decodeURIComponent(key.slice(prefix.length));
      if (!threadId) return { ok: false, issue: "malformed" };
      const source = makeMobileComposerDraftIdentity({
        backendBaseUrl: session.backendBaseUrl,
        sessionId: session.sessionId,
        threadId,
      });
      const target = makeMobileComposerDraftIdentity({
        backendBaseUrl: session.backendBaseUrl,
        sessionId: session.sessionId,
        threadId,
        authorityId,
      });
      const targetKey = mobileComposerDraftKey(target);
      // Existing authority composition wins; malformed/undurable data is never overwritten.
      const existingRaw = storage.getItem(targetKey);
      const existing = readMobileComposerDraft(target);
      if (existingRaw !== null) {
        if (!existing.draft) return { ok: false, issue: "malformed" };
        continue;
      }
      if (existing.draft) return { ok: false, issue: "unavailable" };
      const read = readMobileComposerDraft(source);
      if (!read.draft)
        return { ok: false, issue: read.issue === "unavailable" ? "unavailable" : "malformed" };
      const raw = JSON.stringify(read.draft);
      bytes += raw.length * 2;
      if (bytes > 16 * 1024 * 1024) return { ok: false, issue: "too-many" };
      pending.push({ key: targetKey, raw });
    }
    // Session storage is tab-local and synchronous. Claim once before copying, never another host.
    storage.setItem(receiptKey(session), authorityId);
    if (storage.getItem(receiptKey(session)) !== authorityId)
      return { ok: false, issue: "unavailable" };
    let copied = 0;
    for (const { key, raw } of pending) {
      if (storage.getItem(key) !== null) continue;
      storage.setItem(key, raw);
      if (storage.getItem(key) !== raw) return { ok: false, issue: "unavailable" };
      copied++;
    }
    return { ok: true, copied };
  } catch {
    return { ok: false, issue: "unavailable" };
  }
}

/** Explicit Forget may retire retained v1 data only with its matching one-time authority receipt. */
export function forgetMigratedLegacyMobileDrafts(
  input: MobileComposerDraftSessionIdentity,
): boolean {
  if (!input.authorityId) return true;
  const storage = getMobileComposerDraftStorage();
  if (!storage) return false;
  try {
    if (storage.getItem(receiptKey(input)) !== input.authorityId) return true;
    if (
      !forgetMobileComposerDraftsForSession({
        backendBaseUrl: input.backendBaseUrl,
        sessionId: input.sessionId,
      })
    )
      return false;
    storage.removeItem(receiptKey(input));
    return storage.getItem(receiptKey(input)) === null;
  } catch {
    return false;
  }
}
