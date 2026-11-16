import { getMobileSessionAuthority } from "./mobileSessionAuthority";
import { describe, expect, it } from "vitest";
import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";

import {
  EMPTY_MOBILE_HOST_COLLECTION,
  MOBILE_HOST_COLLECTION_STORAGE_KEY,
  persistMobileHostCollection,
  prepareMobileHostPairing,
  readMobileHostCollection,
  type MobileHostCollection,
} from "./mobileHostCollection";

const now = Date.parse("2026-11-16T00:00:00Z");
const origin = "https://fixture-a.invalid";
const descriptor: RemoteBackendMobileDescriptor = {
  handshakeRevision: 1,
  authority: {
    authorityId: "a".repeat(32),
    keyFingerprint: `sha256:${"b".repeat(64)}`,
    keyEpoch: 1,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  backendVersion: "fixture",
  mobileRpcRevision: 1,
  mobileCapable: true,
};
const session = {
  sessionId: "fixture-session",
  sessionToken: "fixture-token",
  backendBaseUrl: origin,
  scope: "thread-control" as const,
  expiresAt: "2027-01-01T00:00:00.000Z",
};
function pair(
  current = EMPTY_MOBILE_HOST_COLLECTION,
  changes: Partial<Parameters<typeof prepareMobileHostPairing>[0]> = {},
) {
  return prepareMobileHostPairing({
    current,
    descriptor,
    backendOrigin: origin,
    session,
    confirmedFirstSeen: true,
    now,
    ...changes,
  });
}
function paired(): MobileHostCollection {
  const result = pair();
  if (!result.accepted) throw new Error(result.reason);
  return result.value;
}
function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("verified mobile host collection transactions", () => {
  it("persists collection and selected authority atomically, strips unknown fields and stale websocket URLs", () => {
    const target = storage();
    const result = pair(undefined, {
      session: { ...session, websocketUrl: "wss://wrong.invalid", privateField: "ignore" },
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(persistMobileHostCollection(target, result.value)).toBe(true);
    expect(readMobileHostCollection(target)).toEqual({ status: "ready", value: result.value });
    expect(target.data.get(MOBILE_HOST_COLLECTION_STORAGE_KEY)).not.toContain("wrong.invalid");
    expect(target.data.get(MOBILE_HOST_COLLECTION_STORAGE_KEY)).not.toContain("privateField");
  });

  it("never deletes or modifies the legacy singleton, including storage failures", () => {
    const target = storage();
    target.data.set("bigbud:mobile-web:session:v1", "legacy-credential");
    expect(
      persistMobileHostCollection(
        {
          ...target,
          setItem: () => {
            throw new Error("quota");
          },
        },
        paired(),
      ),
    ).toBe(false);
    expect(target.data.get("bigbud:mobile-web:session:v1")).toBe("legacy-credential");
    expect(target.data.has(MOBILE_HOST_COLLECTION_STORAGE_KEY)).toBe(false);
    expect(persistMobileHostCollection(target, paired())).toBe(true);
    expect(target.data.get("bigbud:mobile-web:session:v1")).toBe("legacy-credential");
  });

  it("reports an unconfirmed legacy envelope readback without rolling back or touching the singleton", () => {
    const target = storage();
    target.data.set("bigbud:mobile-web:session:v1", "original-singleton");
    const next = {
      ...EMPTY_MOBILE_HOST_COLLECTION,
      legacySelected: true,
      legacySession: { ...session, websocketUrl: "wss://fixture-a.invalid/mobile-ws" },
    };
    expect(
      persistMobileHostCollection(
        {
          ...target,
          getItem: () => {
            throw new Error("read unavailable after write");
          },
        },
        next,
      ),
    ).toBe(false);
    expect(target.data.get("bigbud:mobile-web:session:v1")).toBe("original-singleton");
    // setItem succeeded: reporting failure must not pretend the durable envelope was unchanged.
    expect(readMobileHostCollection(target)).toEqual({ status: "ready", value: next });
    expect(next.selectedAuthorityId).toBeNull();
    expect(getMobileSessionAuthority(next.legacySession)).toBeNull();
  });

  it("reports corrupted/unavailable storage without repairing or deleting it", () => {
    const target = storage();
    target.data.set(MOBILE_HOST_COLLECTION_STORAGE_KEY, "broken");
    expect(readMobileHostCollection(target)).toEqual({ status: "invalid" });
    expect(target.data.get(MOBILE_HOST_COLLECTION_STORAGE_KEY)).toBe("broken");
    expect(
      readMobileHostCollection({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("distinguishes explicit legacy selection from leaving a verified host without losing the legacy credential", () => {
    const target = storage();
    target.data.set("bigbud:mobile-web:session:v1", "legacy-credential");
    const left = { ...paired(), selectedAuthorityId: null, legacySelected: false };
    expect(persistMobileHostCollection(target, left)).toBe(true);
    expect(readMobileHostCollection(target)).toEqual({ status: "ready", value: left });
    expect(persistMobileHostCollection(target, { ...left, legacySelected: true })).toBe(true);
    expect(readMobileHostCollection(target)).toEqual({
      status: "ready",
      value: { ...left, legacySelected: true },
    });
    expect(target.data.get("bigbud:mobile-web:session:v1")).toBe("legacy-credential");
    expect(readMobileHostCollection(storage())).toEqual({
      status: "ready",
      value: EMPTY_MOBILE_HOST_COLLECTION,
    });
  });

  it("commits legacy credential and selection in one unverified envelope without replacing verified hosts or v1", () => {
    const target = storage();
    target.data.set("bigbud:mobile-web:session:v1", "original-v1-credential");
    const legacy = {
      ...session,
      websocketUrl: "ws://192.168.1.10/mobile-ws",
      backendBaseUrl: "http://192.168.1.10:3000",
      authorityId: "f".repeat(32),
    };
    const value = {
      ...paired(),
      selectedAuthorityId: null,
      legacySelected: true,
      legacySession: legacy,
    };
    expect(persistMobileHostCollection(target, value)).toBe(true);
    const read = readMobileHostCollection(target);
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.value.collection.entries).toEqual(value.collection.entries);
    expect(read.value.legacySession?.backendBaseUrl).toBe("http://192.168.1.10:3000");
    expect(read.value.legacySession).not.toHaveProperty("authorityId");
    expect(getMobileSessionAuthority(read.value.legacySession)).toBeNull();
    expect(target.data.get("bigbud:mobile-web:session:v1")).toBe("original-v1-credential");
    expect(
      persistMobileHostCollection(target, {
        ...read.value,
        legacySelected: false,
        legacySession: null,
      }),
    ).toBe(true);
    expect(readMobileHostCollection(target)).toMatchObject({
      status: "ready",
      value: { legacySession: null, legacySelected: false },
    });
  });

  it("refuses malformed legacy slots and preserves the previous atomic value on write failure", () => {
    const target = storage();
    const value = paired();
    persistMobileHostCollection(target, value);
    const before = target.data.get(MOBILE_HOST_COLLECTION_STORAGE_KEY);
    expect(
      persistMobileHostCollection(
        {
          ...target,
          setItem: () => {
            throw new Error("quota");
          },
        },
        {
          ...value,
          legacySelected: true,
          legacySession: { ...session, websocketUrl: "wss://fixture.invalid" },
        },
      ),
    ).toBe(false);
    expect(target.data.get(MOBILE_HOST_COLLECTION_STORAGE_KEY)).toBe(before);
    target.data.set(
      MOBILE_HOST_COLLECTION_STORAGE_KEY,
      JSON.stringify({
        ...value.collection,
        selectedAuthorityId: null,
        legacySession: { ...session, scope: "admin" },
      }),
    );
    expect(readMobileHostCollection(target)).toEqual({ status: "invalid" });
  });

  it("rejects a selected authority that is absent from the collection", () => {
    expect(
      persistMobileHostCollection(storage(), { ...paired(), selectedAuthorityId: "d".repeat(32) }),
    ).toBe(false);
  });

  it("renews the same authority across versions without adding a host or touching another credential", () => {
    const current = paired();
    const result = pair(current, {
      descriptor: { ...descriptor, backendVersion: "fixture-upgrade" },
      session: { ...session, sessionId: "renewed-session", sessionToken: "renewed-token" },
      confirmedFirstSeen: false,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.collection.entries).toHaveLength(1);
    expect(result.value.collection.entries[0]?.session.sessionToken).toBe("renewed-token");
    expect(current.collection.entries[0]?.session.sessionToken).toBe("fixture-token");
  });

  it("adds a separately confirmed authority without replacing the first", () => {
    const current = paired();
    const nextOrigin = "https://fixture-b.invalid";
    const result = pair(current, {
      backendOrigin: nextOrigin,
      descriptor: {
        ...descriptor,
        authority: { ...descriptor.authority, authorityId: "d".repeat(32) },
      },
      session: { ...session, backendBaseUrl: nextOrigin, sessionToken: "fixture-b-token" },
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.collection.entries).toHaveLength(2);
    expect(result.value.collection.entries[0]).toEqual(current.collection.entries[0]);
  });

  it("requires new-origin confirmation and a fresh original-origin-bound session", () => {
    const current = paired();
    const nextOrigin = "https://fixture-new.invalid";
    expect(pair(current, { backendOrigin: nextOrigin, confirmedFirstSeen: false }).accepted).toBe(
      false,
    );
    expect(pair(current, { backendOrigin: nextOrigin }).accepted).toBe(false);
    const result = pair(current, {
      backendOrigin: nextOrigin,
      session: { ...session, backendBaseUrl: nextOrigin },
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.collection.entries).toHaveLength(1);
    expect(result.value.collection.entries[0]?.backendOrigin).toBe(nextOrigin);
  });

  it("never silently replaces an origin authority, copied installation or rotated key", () => {
    const current = paired();
    expect(
      pair(current, {
        descriptor: {
          ...descriptor,
          authority: { ...descriptor.authority, authorityId: "d".repeat(32) },
        },
      }),
    ).toEqual({ accepted: false, reason: "authority-changed" });
    expect(
      pair(current, {
        descriptor: { ...descriptor, installationFingerprint: `sha256:${"d".repeat(64)}` },
      }),
    ).toEqual({ accepted: false, reason: "duplicate-authority" });
    expect(
      pair(current, {
        descriptor: {
          ...descriptor,
          authority: {
            ...descriptor.authority,
            keyEpoch: 2,
            keyFingerprint: `sha256:${"e".repeat(64)}`,
          },
        },
      }),
    ).toEqual({ accepted: false, reason: "key-rotated" });
    expect(current).toEqual(paired());
  });

  it("refuses expired sessions, unsupported/mobile-unready hosts and unconfirmed first contact", () => {
    expect(
      pair(undefined, { session: { ...session, expiresAt: "2026-01-01T00:00:00Z" } }).accepted,
    ).toBe(false);
    expect(pair(undefined, { descriptor: { ...descriptor, mobileCapable: false } }).accepted).toBe(
      false,
    );
    expect(
      pair(undefined, { descriptor: { ...descriptor, mobileRpcRevision: 999 } }).accepted,
    ).toBe(false);
    expect(pair(undefined, { confirmedFirstSeen: false }).accepted).toBe(false);
  });
});
