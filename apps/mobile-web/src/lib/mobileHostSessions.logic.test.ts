import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";
import { describe, expect, it } from "vitest";

import {
  canonicalMobileHostOrigin,
  decodeMobileHostSessions,
  prepareMobileHostSessionMigration,
  type MobileHostSessions,
} from "./mobileHostSessions.logic";

const descriptor: RemoteBackendMobileDescriptor = {
  handshakeRevision: 1,
  authority: {
    authorityId: "a".repeat(32),
    keyFingerprint: `sha256:${"b".repeat(64)}`,
    keyEpoch: 1,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  backendVersion: "0.1.0",
  mobileRpcRevision: 1,
  mobileCapable: true,
};
const legacySession = {
  sessionId: "session-1",
  sessionToken: "test-credential",
  backendBaseUrl: "https://one.example/",
  websocketUrl: "wss://other.example/mobile-ws?token=stale",
  scope: "thread-control",
  expiresAt: "2026-12-01T00:00:00.000Z",
};
const empty: MobileHostSessions = { version: 2, entries: [] };
const input = {
  collection: empty,
  legacySession,
  descriptor,
  confirmedPin: descriptor,
  observedOrigin: "https://one.example",
  support: { minimumMobileRpcRevision: 1, maximumMobileRpcRevision: 1 },
  now: Date.parse("2026-11-15T00:00:00.000Z"),
};

describe("mobile host session migration preparation", () => {
  it("creates exactly one authority entry without mutating/removing the singleton", () => {
    const before = structuredClone(input);
    const result = prepareMobileHostSessionMigration(input);
    expect(result.status).toBe("migrated");
    expect(result.collection.entries).toHaveLength(1);
    const entry = result.collection.entries[0]!;
    expect(entry.pin).toEqual({
      authority: descriptor.authority,
      installationFingerprint: descriptor.installationFingerprint,
    });
    expect(entry.backendOrigin).toBe("https://one.example");
    expect(entry.session.backendBaseUrl).toBe("https://one.example");
    expect(entry.session.sessionToken).toBe(legacySession.sessionToken);
    expect(entry.session).not.toHaveProperty("websocketUrl");
    expect(input).toEqual(before);
    expect(decodeMobileHostSessions(result.collection)).toEqual(result.collection);
  });

  it("rejects first contact, disabled access, unsupported revisions and changed identities", () => {
    const attempts = [
      { ...input, confirmedPin: null },
      { ...input, descriptor: { ...descriptor, mobileCapable: false } },
      { ...input, descriptor: { ...descriptor, mobileRpcRevision: 2 } },
      {
        ...input,
        descriptor: { ...descriptor, installationFingerprint: `sha256:${"d".repeat(64)}` },
      },
      {
        ...input,
        descriptor: {
          ...descriptor,
          authority: { ...descriptor.authority, keyEpoch: 2 },
        },
      },
    ];
    for (const attempt of attempts) {
      const result = prepareMobileHostSessionMigration(attempt);
      expect(result).toEqual({ status: "rejected", collection: empty });
      expect(result.collection).toBe(empty);
    }
  });

  it("never forwards a legacy credential to a changed origin or a path/query destination", () => {
    for (const observedOrigin of [
      "https://two.example",
      "https://one.example/mobile/",
      "https://one.example/?token=x",
      "https://user@one.example",
    ]) {
      expect(prepareMobileHostSessionMigration({ ...input, observedOrigin }).status).toBe(
        "rejected",
      );
    }
  });

  it("does not replace an existing authority when migrated twice or backend version changes", () => {
    const first = prepareMobileHostSessionMigration(input).collection;
    const result = prepareMobileHostSessionMigration({
      ...input,
      collection: first,
      descriptor: { ...descriptor, backendVersion: "9.0.0" },
    });
    expect(result.status).toBe("rejected");
    expect(result.collection).toBe(first);
    expect(first.entries).toHaveLength(1);
  });

  it.each([
    null,
    { ...legacySession, sessionToken: "" },
    { ...legacySession, scope: "admin" },
    { ...legacySession, expiresAt: "not-a-date" },
    { ...legacySession, expiresAt: "2026-11-15T00:00:00.000Z" },
    { ...legacySession, backendBaseUrl: "https://two.example" },
  ])("preserves the original collection for an unusable legacy record", (legacy) => {
    const result = prepareMobileHostSessionMigration({ ...input, legacySession: legacy });
    expect(result.status).toBe("rejected");
    expect(result.collection).toBe(empty);
  });
});

describe("mobile host collection decoding", () => {
  const valid = prepareMobileHostSessionMigration(input).collection;
  const entry = valid.entries[0]!;

  it("strips unknown fields rather than carrying them into the versioned collection", () => {
    expect(
      decodeMobileHostSessions({
        ...valid,
        unknown: "discard",
        entries: [{ ...entry, pin: { ...entry.pin, privateKey: "discard" } }],
      }),
    ).toEqual(valid);
  });

  it.each([
    null,
    { version: 1, entries: [] },
    { version: 2, entries: {} },
    { version: 2, entries: [entry, entry] },
    {
      version: 2,
      entries: Array.from({ length: 33 }, (_, index) => ({
        ...entry,
        pin: {
          ...entry.pin,
          authority: { ...entry.pin.authority, authorityId: index.toString(16).padStart(32, "0") },
        },
      })),
    },
    { version: 2, entries: [{ ...entry, backendOrigin: "https://one.example/" }] },
    {
      version: 2,
      entries: [{ ...entry, session: { ...entry.session, backendBaseUrl: "https://two.example" } }],
    },
    { version: 2, entries: [{ ...entry, pin: { ...entry.pin, authority: [] } }] },
  ])("fails closed for malformed, duplicate or misbound collections", (raw) => {
    expect(decodeMobileHostSessions(raw)).toBeNull();
  });

  it("keeps separate authorities separate at one origin without display-name matching", () => {
    const other = {
      ...entry,
      pin: { ...entry.pin, authority: { ...entry.pin.authority, authorityId: "d".repeat(32) } },
    };
    expect(decodeMobileHostSessions({ version: 2, entries: [entry, other] })?.entries).toHaveLength(
      2,
    );
  });
  it("accepts the bounded collection at its capacity", () => {
    const entries = Array.from({ length: 32 }, (_, index) => ({
      ...entry,
      pin: {
        ...entry.pin,
        authority: { ...entry.pin.authority, authorityId: index.toString(16).padStart(32, "0") },
      },
    }));
    expect(decodeMobileHostSessions({ version: 2, entries })?.entries).toHaveLength(32);
    expect(
      prepareMobileHostSessionMigration({ ...input, collection: { version: 2, entries } }).status,
    ).toBe("rejected");
  });
});

describe("canonical mobile host origin", () => {
  it("normalizes host case and default port", () => {
    expect(canonicalMobileHostOrigin("https://ONE.example:443/")).toBe("https://one.example");
  });

  it.each([
    "http://one.example",
    "javascript:alert(1)",
    "https://user:secret@one.example",
    "https://one.example/mobile/",
    "https://one.example/?token=secret",
    "https://one.example/#secret",
    "not a URL",
  ])("rejects unsafe or non-origin input %s", (value) => {
    expect(canonicalMobileHostOrigin(value)).toBeNull();
  });
});
