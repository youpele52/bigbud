import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";
import { describe, expect, it } from "vitest";

import { matchesUsableMobileHost, mobileHostStateKey } from "./mobileHostIdentity.logic";

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
const support = { minimumMobileRpcRevision: 1, maximumMobileRpcRevision: 1 };

describe("mobile host identity admission", () => {
  it("requires a matching confirmed pin, supported revisions and mobile availability", () => {
    expect(matchesUsableMobileHost(descriptor, descriptor, support)).toBe(true);
    expect(matchesUsableMobileHost(descriptor, null, support)).toBe(false);
    expect(
      matchesUsableMobileHost({ ...descriptor, mobileCapable: false }, descriptor, support),
    ).toBe(false);
    expect(
      matchesUsableMobileHost({ ...descriptor, mobileRpcRevision: 2 }, descriptor, support),
    ).toBe(false);
  });

  it("does not silently accept rotations, copied installations or reused hostnames", () => {
    for (const changed of [
      {
        ...descriptor,
        authority: {
          ...descriptor.authority,
          keyEpoch: 2,
          keyFingerprint: `sha256:${"d".repeat(64)}`,
        },
      },
      { ...descriptor, installationFingerprint: `sha256:${"e".repeat(64)}` },
      { ...descriptor, authority: { ...descriptor.authority, authorityId: "f".repeat(32) } },
    ]) {
      expect(matchesUsableMobileHost(changed, descriptor, support)).toBe(false);
    }
  });
});

describe("mobile authority state namespace", () => {
  it("isolates all state areas across hosts even with identical session/thread identifiers", () => {
    for (const area of ["query", "draft", "command", "replay", "selection"] as const) {
      expect(mobileHostStateKey("a".repeat(32), area, "session", "thread")).not.toBe(
        mobileHostStateKey("b".repeat(32), area, "session", "thread"),
      );
    }
    expect(mobileHostStateKey("a".repeat(32), "draft", "thread")).not.toBe(
      mobileHostStateKey("a".repeat(32), "query", "thread"),
    );
  });

  it("keeps tuple boundaries unambiguous and preserves exact identifiers", () => {
    expect(mobileHostStateKey("a".repeat(32), "draft", "a:b", "c")).not.toBe(
      mobileHostStateKey("a".repeat(32), "draft", "a", "b:c"),
    );
    expect(JSON.parse(mobileHostStateKey("a".repeat(32), "replay", "", 'a"b'))).toEqual([
      "bigbud:mobile-host:v1",
      "a".repeat(32),
      "replay",
      "",
      'a"b',
    ]);
  });

  it.each(["", "a".repeat(31), "A".repeat(32), "__proto__", "host.example"])(
    "refuses invalid authority IDs instead of creating ambiguous namespaces: %s",
    (authorityId) => {
      expect(() => mobileHostStateKey(authorityId, "query", "thread")).toThrow();
    },
  );
});
