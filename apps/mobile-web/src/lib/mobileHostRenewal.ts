import type { MobileHostEntry } from "./mobileHostConnection";
import { canonicalMobileHostOrigin } from "./mobileHostSessions.logic";
import { snapshotMobileComposerSession, type MobileSubmittedCommand } from "./mobileComposerDraft";
import {
  mobileComposerDraftKey,
  makeMobileComposerDraftIdentity,
} from "./mobileComposerDraft.identity";
import { getMobileComposerDraftStorage } from "./mobileComposerDraft.storage";
import { decodeStoredMobileSession } from "./mobileSession.codec";
import * as Schema from "effect/Schema";
import {
  RemoteBackendAuthority,
  RemoteBackendInstallationFingerprint,
} from "@bigbud/contracts/server/remoteBackendHandshake";
import { clearMobileDraftThreads } from "./mobileDraftThread";

const PREFIX = "bigbud:mobile-renewal:v1:";
const RenewalJournalSchema = Schema.Struct({
  version: Schema.Literal(1),
  pin: Schema.Struct({
    authority: RemoteBackendAuthority,
    installationFingerprint: RemoteBackendInstallationFingerprint,
  }),
  origin: Schema.String,
  from: Schema.String.check(Schema.isMinLength(1)),
  to: Schema.String.check(Schema.isMinLength(1)),
  copies: Schema.Array(Schema.Struct({ key: Schema.String, raw: Schema.String })),
  phase: Schema.Literals(["copying", "copied"]),
});
type RenewalJournal = typeof RenewalJournalSchema.Type;
export function isSameMobileRenewalHost(a: MobileHostEntry, b: MobileHostEntry): boolean {
  return (
    a.backendOrigin === b.backendOrigin &&
    canonicalMobileHostOrigin(a.backendOrigin) === a.backendOrigin &&
    a.pin.authority.authorityId === b.pin.authority.authorityId &&
    a.pin.authority.keyEpoch === b.pin.authority.keyEpoch &&
    a.pin.authority.keyFingerprint === b.pin.authority.keyFingerprint &&
    a.pin.installationFingerprint === b.pin.installationFingerprint
  );
}
const keyFor = (entry: MobileHostEntry) =>
  PREFIX +
  encodeURIComponent(
    JSON.stringify([
      entry.pin.authority.authorityId,
      entry.pin.authority.keyEpoch,
      entry.pin.authority.keyFingerprint,
      entry.pin.installationFingerprint,
      entry.backendOrigin,
      entry.session.sessionId,
    ]),
  );
function carried(command: MobileSubmittedCommand | null | undefined, source: MobileHostEntry) {
  if (!command) return command;
  return {
    ...command,
    ...(command.status === "pending" || command.status === "reconciling"
      ? { status: "uncertain" as const }
      : {}),
    receiptSource: command.receiptSource ?? {
      ...source.pin,
      backendOrigin: source.backendOrigin,
      sessionId: source.session.sessionId,
    },
  };
}

/** An old cached reader must not fall back to the replaced singleton after refusing envelope v3. */
export function retireMatchingRenewalLegacySession(old: MobileHostEntry): boolean {
  try {
    const storage = window.localStorage;
    const key = "bigbud:mobile-web:session:v1";
    const raw = storage.getItem(key);
    const legacy = raw === null ? null : decodeStoredMobileSession(JSON.parse(raw));
    if (
      !legacy ||
      legacy.sessionId !== old.session.sessionId ||
      legacy.sessionToken !== old.session.sessionToken ||
      legacy.backendBaseUrl !== old.backendOrigin ||
      legacy.scope !== old.session.scope ||
      legacy.expiresAt !== old.session.expiresAt
    )
      return true;
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    return false;
  }
}

/** Synchronous tab-local journal: copies must be durable before a replacement credential commits.
 * Old payloads and original command/session provenance remain untouched. Quota failure denies commit. */
export function prepareMobileHostRenewal(old: MobileHostEntry, next: MobileHostEntry): boolean {
  if (!isSameMobileRenewalHost(old, next)) return false;
  if (old.session.sessionId === next.session.sessionId)
    return old.session.sessionToken === next.session.sessionToken;
  const storage = getMobileComposerDraftStorage();
  if (!storage) return false;
  try {
    const snapshots = snapshotMobileComposerSession({
      backendBaseUrl: old.backendOrigin,
      sessionId: old.session.sessionId,
      authorityId: old.pin.authority.authorityId,
    });
    const copies = snapshots.map(({ identity, draft }) => ({
      key: mobileComposerDraftKey(
        makeMobileComposerDraftIdentity({
          backendBaseUrl: next.backendOrigin,
          sessionId: next.session.sessionId,
          authorityId: next.pin.authority.authorityId,
          threadId: identity.threadId,
        }),
      ),
      raw: JSON.stringify({
        ...draft,
        version: 2,
        submitted: carried(draft.submitted, old),
        ...(draft.decisionSubmitted === undefined
          ? {}
          : { decisionSubmitted: carried(draft.decisionSubmitted, old) }),
      }),
    }));
    const journal: RenewalJournal = {
      version: 1,
      pin: next.pin,
      origin: next.backendOrigin,
      from: old.session.sessionId,
      to: next.session.sessionId,
      copies,
      phase: "copying",
    };
    const raw = JSON.stringify(Schema.decodeUnknownSync(RenewalJournalSchema)(journal));
    if (raw.length * 2 > 16 * 1024 * 1024) return false;
    const key = keyFor(next),
      existing = storage.getItem(key);
    if (existing !== null) {
      // Only an exact prior attempt may resume; unrelated target drafts are never overwritten.
      const previous = Schema.decodeUnknownSync(RenewalJournalSchema)(JSON.parse(existing), {
        onExcessProperty: "error",
      });
      if (JSON.stringify({ ...previous, phase: "copying" }) !== raw) return false;
    } else {
      if (copies.some((copy) => storage.getItem(copy.key) !== null)) return false;
      storage.setItem(key, raw);
      if (storage.getItem(key) !== raw) return false;
    }
    for (const copy of copies) {
      const present = storage.getItem(copy.key);
      if (present !== null && present !== copy.raw) return false;
      storage.setItem(copy.key, copy.raw);
      if (storage.getItem(copy.key) !== copy.raw) return false;
    }
    const completed = JSON.stringify(
      Schema.decodeUnknownSync(RenewalJournalSchema)({ ...journal, phase: "copied" }),
    );
    storage.setItem(key, completed);
    return storage.getItem(key) === completed;
  } catch {
    return false;
  }
}

/** Explicit Forget follows only completed receipts for this full pin and exact renewal chain. */
export function forgetRenewedMobileDrafts(selected: MobileHostEntry): boolean {
  const storage = getMobileComposerDraftStorage();
  if (!storage) return false;
  try {
    const chain: Array<{ key: string; source: MobileHostEntry }> = [];
    const visited = new Set<string>();
    let entry = selected;
    for (;;) {
      const key = keyFor(entry),
        raw = storage.getItem(key);
      if (raw === null) break;
      if (visited.has(key) || chain.length >= 512 || raw.length * 2 > 16 * 1024 * 1024)
        return false;
      visited.add(key);
      const journal = Schema.decodeUnknownSync(RenewalJournalSchema)(JSON.parse(raw), {
        onExcessProperty: "error",
      });
      const source = {
        ...entry,
        pin: journal.pin,
        backendOrigin: journal.origin,
        session: { ...entry.session, sessionId: journal.from },
      };
      if (
        journal.phase !== "copied" ||
        journal.to !== entry.session.sessionId ||
        journal.from === journal.to ||
        !isSameMobileRenewalHost(entry, source)
      )
        return false;
      chain.push({ key, source });
      entry = source;
    }
    for (const { source } of chain) {
      if (
        !clearMobileDraftThreads({
          backendBaseUrl: source.backendOrigin,
          sessionId: source.session.sessionId,
          authorityId: source.pin.authority.authorityId,
        })
      )
        return false;
    }
    for (const { key } of chain.toReversed()) {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}
