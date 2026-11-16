import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { CommandId, ThreadId } from "@bigbud/contracts";
import * as Schema from "effect/Schema";
import type { MobileHostEntry } from "./mobileHostConnection";
import {
  createMobileComposerDraft,
  beginMobileComposerDraftLease,
  writeMobileComposerDraftWithLease,
  readMobileComposerDraft,
  writeMobileComposerDraft,
} from "./mobileComposerDraft";
import {
  mobileComposerDraftKey,
  makeMobileComposerDraftIdentity,
} from "./mobileComposerDraft.identity";
import { LegacyMobileComposerDraftSchema } from "./mobileComposerDraft.schema";
import {
  createMobileCommandDeliveryController,
  createMobileCommandDeliveryState,
} from "./mobileCommandDelivery";
import { selectCommandToRecheck } from "../screens/MobileThread.delivery.reconciliation";
import {
  prepareMobileHostRenewal,
  forgetRenewedMobileDrafts,
  retireMatchingRenewalLegacySession,
} from "./mobileHostRenewal";
import { decodeMobileHostSessions } from "./mobileHostSessions.logic";
import {
  persistMobileHostCollection,
  readMobileHostCollection,
  MOBILE_HOST_COLLECTION_STORAGE_KEY,
  sameMobileHostCollection,
} from "./mobileHostCollection";

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, raw: string) => {
      data.set(key, raw);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}
let drafts: ReturnType<typeof storage>, hosts: ReturnType<typeof storage>;
const old: MobileHostEntry = {
  pin: {
    authority: {
      authorityId: "a".repeat(32),
      keyEpoch: 1,
      keyFingerprint: `sha256:${"b".repeat(64)}`,
    },
    installationFingerprint: `sha256:${"c".repeat(64)}`,
  },
  backendOrigin: "https://renewal.invalid",
  session: {
    sessionId: "old-grant",
    sessionToken: "old-token",
    backendBaseUrl: "https://renewal.invalid",
    scope: "thread-control",
    expiresAt: "2027-01-01T00:00:00.000Z",
  },
};
const next: MobileHostEntry = {
  ...old,
  session: {
    ...old.session,
    sessionId: "new-grant",
    sessionToken: "new-token",
    scope: "read-only",
  },
};
const identity = (entry: MobileHostEntry, threadId = "renewal-thread") =>
  makeMobileComposerDraftIdentity({
    backendBaseUrl: entry.backendOrigin,
    sessionId: entry.session.sessionId,
    authorityId: entry.pin.authority.authorityId,
    threadId,
  });
function seed(thread = "renewal-thread") {
  const draft = createMobileComposerDraft({
    threadId: ThreadId.makeUnsafe(thread),
    prompt: "Keep uncertain draft",
  });
  const submitted = {
    command: {
      type: "thread.turn.interrupt" as const,
      commandId: CommandId.makeUnsafe("original-command"),
      threadId: draft.threadId,
      createdAt: draft.updatedAt,
    },
    submittedAt: draft.updatedAt,
    submittedRevision: 3,
    deadlineAt: 100,
    status: "pending" as const,
  };
  const value = { ...draft, submitted, decisionSubmitted: submitted };
  expect(writeMobileComposerDraft(identity(old, thread), value).ok).toBe(true);
  return value;
}
beforeEach(() => {
  drafts = storage();
  hosts = storage();
  vi.stubGlobal("sessionStorage", drafts);
  vi.stubGlobal("window", { localStorage: hosts });
  beginMobileComposerDraftLease(identity(old));
  beginMobileComposerDraftLease(identity(next));
});
afterEach(() => vi.unstubAllGlobals());

it("retains original command/session provenance, fences retired writers, and refuses old codecs", async () => {
  const original = seed(),
    lease = beginMobileComposerDraftLease(identity(old));
  expect(prepareMobileHostRenewal(old, next)).toBe(true);
  expect(
    writeMobileComposerDraftWithLease(lease, { ...original, prompt: "late old callback" }).ok,
  ).toBe(false);
  const restored = readMobileComposerDraft(identity(next)).draft!;
  expect(restored).toMatchObject({
    version: 2,
    prompt: original.prompt,
    submitted: {
      status: "uncertain",
      command: original.submitted.command,
      receiptSource: {
        ...old.pin,
        backendOrigin: old.backendOrigin,
        sessionId: old.session.sessionId,
      },
    },
  });
  expect(restored.decisionSubmitted?.receiptSource).toEqual(restored.submitted?.receiptSource);
  expect(() => Schema.decodeUnknownSync(LegacyMobileComposerDraftSchema)(restored)).toThrow();
  expect(readMobileComposerDraft(identity(old)).draft).toEqual(original);
  const state = createMobileCommandDeliveryState(restored.submitted),
    dispatch = vi.fn(),
    receipt = vi.fn();
  const controller = createMobileCommandDeliveryController({ initialState: state });
  await controller.reconcile(receipt);
  await controller.retrySameOperation(dispatch);
  expect(receipt).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(selectCommandToRecheck({ freshness: "current", state, checked: new Set() })).toBeNull();
  const envelope = {
    collection: { version: 2 as const, entries: [next] },
    selectedAuthorityId: next.pin.authority.authorityId,
    storageVersion: 3 as const,
  };
  expect(persistMobileHostCollection(hosts, envelope)).toBe(true);
  expect(
    decodeMobileHostSessions(JSON.parse(hosts.getItem(MOBILE_HOST_COLLECTION_STORAGE_KEY)!)),
  ).toBeNull();
  expect(readMobileHostCollection(hosts)).toEqual({ status: "ready", value: envelope });
  const fresh = readMobileHostCollection(hosts);
  if (fresh.status !== "ready") throw Error("Expected confirmed durable collection");
  expect(sameMobileHostCollection(envelope, fresh.value)).toBe(true);
  expect(sameMobileHostCollection(envelope, { ...fresh.value, selectedAuthorityId: null })).toBe(
    false,
  );
});

it("resumes a partial durable copy without overwriting foreign target content", () => {
  seed();
  seed("second-thread");
  const set = drafts.setItem;
  let copies = 0;
  drafts.setItem = (key, raw) => {
    if (key.includes("new-grant") && !key.startsWith("bigbud:mobile-renewal") && ++copies === 2)
      throw Error("quota");
    set(key, raw);
  };
  expect(prepareMobileHostRenewal(old, next)).toBe(false);
  expect(readMobileComposerDraft(identity(old)).draft?.prompt).toBe("Keep uncertain draft");
  drafts.setItem = set;
  expect(prepareMobileHostRenewal(old, next)).toBe(true);
  expect(prepareMobileHostRenewal(old, next)).toBe(true);
  drafts.setItem(mobileComposerDraftKey(identity(next)), "foreign target");
  expect(prepareMobileHostRenewal(old, next)).toBe(false);
  expect(drafts.getItem(mobileComposerDraftKey(identity(next)))).toBe("foreign target");
});

it.each(["origin", "authorityId", "keyEpoch", "keyFingerprint", "installationFingerprint"])(
  "refuses %s changes before copying",
  (field) => {
    seed();
    const changed: MobileHostEntry = {
      ...next,
      backendOrigin: field === "origin" ? "https://other.invalid" : next.backendOrigin,
      pin: {
        installationFingerprint:
          field === "installationFingerprint"
            ? `sha256:${"d".repeat(64)}`
            : next.pin.installationFingerprint,
        authority: {
          authorityId: field === "authorityId" ? "d".repeat(32) : next.pin.authority.authorityId,
          keyEpoch: field === "keyEpoch" ? 2 : next.pin.authority.keyEpoch,
          keyFingerprint:
            field === "keyFingerprint"
              ? `sha256:${"d".repeat(64)}`
              : next.pin.authority.keyFingerprint,
        },
      },
    };
    const before = [...drafts.data];
    expect(prepareMobileHostRenewal(old, changed)).toBe(false);
    expect([...drafts.data]).toEqual(before);
  },
);

it("retires only an exactly matching singleton and preserves it when a storage operation fails", () => {
  const key = "bigbud:mobile-web:session:v1";
  const legacy = { ...old.session, websocketUrl: "wss://renewal.invalid/mobile-ws" };
  hosts.setItem(key, JSON.stringify(legacy));
  expect(retireMatchingRenewalLegacySession(old)).toBe(true);
  expect(hosts.getItem(key)).toBeNull();
  hosts.setItem(key, JSON.stringify({ ...legacy, sessionToken: "unrelated" }));
  expect(retireMatchingRenewalLegacySession(old)).toBe(true);
  expect(hosts.getItem(key)).toContain("unrelated");
  hosts.getItem = () => {
    throw Error("unavailable");
  };
  expect(retireMatchingRenewalLegacySession(old)).toBe(false);
});

it("explicit Forget follows completed same-pin receipts and leaves unrelated drafts intact", () => {
  seed();
  expect(prepareMobileHostRenewal(old, next)).toBe(true);
  const third = { ...next, session: { ...next.session, sessionId: "third-grant" } };
  expect(prepareMobileHostRenewal(next, third)).toBe(true);
  const foreign = { ...old, session: { ...old.session, sessionId: "unrelated-grant" } };
  writeMobileComposerDraft(
    identity(foreign),
    createMobileComposerDraft({
      threadId: ThreadId.makeUnsafe("renewal-thread"),
      prompt: "Unrelated",
    }),
  );
  expect(forgetRenewedMobileDrafts(third)).toBe(true);
  expect(readMobileComposerDraft(identity(old)).draft).toBeNull();
  expect(readMobileComposerDraft(identity(next)).draft).toBeNull();
  expect(readMobileComposerDraft(identity(foreign)).draft?.prompt).toBe("Unrelated");
});

it("keeps old credentials usable before commit and retains provenance after an indeterminate commit", () => {
  // A restart before replacement commit must still read the original v2 credential and source.
  seed();
  const original = {
    collection: { version: 2 as const, entries: [old] },
    selectedAuthorityId: old.pin.authority.authorityId,
  };
  expect(persistMobileHostCollection(hosts, original)).toBe(true);
  expect(prepareMobileHostRenewal(old, next)).toBe(true);
  expect(readMobileHostCollection(hosts)).toEqual({ status: "ready", value: original });
  // setItem succeeded but the verification read failed: don't roll back unknown durable state.
  const replacement = {
    ...original,
    collection: { version: 2 as const, entries: [next] },
    storageVersion: 3 as const,
  };
  expect(
    persistMobileHostCollection(
      {
        setItem: hosts.setItem,
        getItem: () => {
          throw Error("readback");
        },
      },
      replacement,
    ),
  ).toBe(false);
  expect(readMobileHostCollection(hosts)).toEqual({ status: "ready", value: replacement });
  expect(readMobileComposerDraft(identity(next)).draft?.submitted?.receiptSource?.sessionId).toBe(
    old.session.sessionId,
  );
  expect(readMobileComposerDraft(identity(old)).draft?.submitted?.command.commandId).toBe(
    "original-command",
  );
});
