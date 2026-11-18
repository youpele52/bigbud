import { createMobileDeliveryOwner } from "../screens/MobileThread.delivery.owner";
import { createMobileDeliveryReconciliationTracker } from "../screens/MobileThread.delivery.reconciliation";
import { CommandId, ThreadId } from "@bigbud/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindMobileSessionAuthority } from "./mobileSessionAuthority";
import type { StoredMobileSession } from "./mobileSession";
import {
  createMobileComposerDraft,
  readMobileComposerDraft,
  writeMobileComposerDraft,
  beginMobileComposerDraftLease,
  invalidateMobileComposerDraftLease,
  writeMobileComposerDraftWithLease,
} from "./mobileComposerDraft";
import {
  makeMobileComposerDraftIdentity,
  mobileComposerDraftKey,
} from "./mobileComposerDraft.identity";
import { migrateMobileSessionDrafts } from "./mobileComposerDraft.migration";
import { clearMobileDraftThreads } from "./mobileDraftThread";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
  key: (index: number) => [...values.keys()][index] ?? null,
  get length() {
    return values.size;
  },
};
let count = 0;
let session: StoredMobileSession;
beforeEach(() => {
  values.clear();
  session = {
    sessionId: `same-session-${++count}`,
    sessionToken: "private-token",
    backendBaseUrl: "https://host.example",
    websocketUrl: "",
    scope: "thread-control",
    expiresAt: "2099-01-01T00:00:00Z",
  };
  vi.stubGlobal("sessionStorage", storage);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function identities() {
  const legacy = makeMobileComposerDraftIdentity({ ...session, threadId: "same-thread" });
  const a = makeMobileComposerDraftIdentity({
    ...session,
    threadId: "same-thread",
    authorityId: "a".repeat(32),
  });
  const b = makeMobileComposerDraftIdentity({
    ...session,
    threadId: "same-thread",
    authorityId: "b".repeat(32),
  });
  return { legacy, a, b };
}
function uncertain() {
  const draft = createMobileComposerDraft({
    threadId: ThreadId.makeUnsafe("same-thread"),
    prompt: "Retain my work",
  });
  return {
    ...draft,
    revision: 7,
    submitted: {
      command: {
        type: "thread.turn.interrupt" as const,
        commandId: CommandId.makeUnsafe("original-command-id"),
        threadId: draft.threadId,
        createdAt: draft.updatedAt,
      },
      submittedRevision: 6,
      submittedAt: draft.updatedAt,
      deadlineAt: 1,
      status: "uncertain" as const,
    },
  };
}
it("isolates identical origin/session/thread drafts and leases by admitted authority", () => {
  const { legacy, a, b } = identities();
  const draft = uncertain();
  const lease = beginMobileComposerDraftLease(a);
  expect(writeMobileComposerDraftWithLease(lease, draft).ok).toBe(true);
  expect(readMobileComposerDraft(b).draft).toBeNull();
  expect(readMobileComposerDraft(legacy).draft).toBeNull();
  expect(clearMobileDraftThreads({ ...session, authorityId: "b".repeat(32) })).toBe(true);
  expect(writeMobileComposerDraftWithLease(lease, { ...draft, prompt: "Still owned A" }).ok).toBe(
    true,
  );
  expect(readMobileComposerDraft(a).draft?.prompt).toBe("Still owned A");
});
it("keeps exact legacy keys and copies original uncertain identity only after admission", () => {
  const { legacy, a } = identities();
  const draft = uncertain();
  writeMobileComposerDraft(legacy, draft);
  const raw = values.get(mobileComposerDraftKey(legacy));
  expect(mobileComposerDraftKey(legacy)).toBe(
    ["bigbud:mobile-composition:v1", "https://host.example", session.sessionId, "same-thread"]
      .map(encodeURIComponent)
      .join(":"),
  );
  expect(migrateMobileSessionDrafts(session)).toEqual({ ok: false, issue: "unverified" });
  bindMobileSessionAuthority(session, "a".repeat(32));
  expect(migrateMobileSessionDrafts(session)).toEqual({ ok: true, copied: 1 });
  expect(readMobileComposerDraft(a).draft).toEqual(draft);
  expect(values.get(mobileComposerDraftKey(legacy))).toBe(raw);
  expect(migrateMobileSessionDrafts(session)).toEqual({ ok: true, copied: 0 });
});
it("refuses another authority claiming retained legacy data", () => {
  const { legacy, b } = identities();
  writeMobileComposerDraft(legacy, uncertain());
  migrateMobileSessionDrafts(bindMobileSessionAuthority(session, "a".repeat(32)));
  expect(
    migrateMobileSessionDrafts(bindMobileSessionAuthority({ ...session }, "b".repeat(32))),
  ).toEqual({ ok: false, issue: "foreign-claim" });
  expect(readMobileComposerDraft(b).draft).toBeNull();
});
it("preserves existing authority composition and malformed bytes without overwriting", () => {
  const { legacy, a } = identities();
  writeMobileComposerDraft(legacy, uncertain());
  const newer = { ...uncertain(), prompt: "Authority draft wins", revision: 99 };
  writeMobileComposerDraft(a, newer);
  bindMobileSessionAuthority(session, "a".repeat(32));
  expect(migrateMobileSessionDrafts(session)).toEqual({ ok: true, copied: 0 });
  expect(readMobileComposerDraft(a).draft).toEqual(newer);
  values.set(mobileComposerDraftKey(a), "malformed-original");
  expect(migrateMobileSessionDrafts(session)).toEqual({ ok: false, issue: "malformed" });
  expect(values.get(mobileComposerDraftKey(a))).toBe("malformed-original");
});
it("keeps legacy bytes on quota failure and permits same-authority retry", () => {
  const { legacy, a } = identities();
  writeMobileComposerDraft(legacy, uncertain());
  const raw = values.get(mobileComposerDraftKey(legacy));
  bindMobileSessionAuthority(session, "a".repeat(32));
  const original = storage.setItem;
  vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
    if (key === mobileComposerDraftKey(a)) throw new DOMException("full", "QuotaExceededError");
    original(key, value);
  });
  expect(migrateMobileSessionDrafts(session)).toEqual({ ok: false, issue: "unavailable" });
  expect(values.get(mobileComposerDraftKey(legacy))).toBe(raw);
  vi.restoreAllMocks();
  expect(migrateMobileSessionDrafts(session)).toEqual({ ok: true, copied: 1 });
});
it("explicit Forget clears only the matching authority and its positively claimed legacy copy", () => {
  const { legacy, a, b } = identities();
  writeMobileComposerDraft(legacy, uncertain());
  writeMobileComposerDraft(b, { ...uncertain(), prompt: "Other host retained" });
  migrateMobileSessionDrafts(bindMobileSessionAuthority(session, "a".repeat(32)));
  expect(clearMobileDraftThreads({ ...session, authorityId: "a".repeat(32) })).toBe(true);
  expect(readMobileComposerDraft(legacy).draft).toBeNull();
  expect(readMobileComposerDraft(a).draft).toBeNull();
  expect(readMobileComposerDraft(b).draft?.prompt).toBe("Other host retained");
});

it("ignores a forged serialized authority field while migrating the privately admitted session", () => {
  const { legacy, a } = identities();
  writeMobileComposerDraft(legacy, uncertain());
  Object.assign(session, { authorityId: "b".repeat(32) });
  bindMobileSessionAuthority(session, "a".repeat(32));
  expect(migrateMobileSessionDrafts(session)).toEqual({ ok: true, copied: 1 });
  expect(readMobileComposerDraft(a).draft?.submitted?.command.commandId).toBe(
    "original-command-id",
  );
});

it("restores the original uncertain delivery owner on the first render after a host is left", () => {
  const { a } = identities();
  const lease = beginMobileComposerDraftLease(a);
  const draft = uncertain();
  expect(writeMobileComposerDraftWithLease(lease, draft).ok).toBe(true);
  // This is the existing ordinary route/host cleanup API, not explicit Forget.
  invalidateMobileComposerDraftLease(a);
  const restored = readMobileComposerDraft(a).draft;
  const owner = createMobileDeliveryOwner({
    identity: mobileComposerDraftKey(a),
    submitted: restored?.submitted ?? null,
    decisionSubmitted: restored?.decisionSubmitted ?? null,
    onStateChange: () => {},
    onDecisionStateChange: () => {},
  });
  expect(writeMobileComposerDraftWithLease(lease, { ...draft, prompt: "retired write" }).ok).toBe(
    false,
  );
  expect(createMobileDeliveryReconciliationTracker().select(owner.delivery)).toBe(
    "original-command-id",
  );
  owner.dispose();
});
