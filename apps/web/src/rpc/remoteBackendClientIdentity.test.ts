import type { RemoteBackendClientHandshake } from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import { describe, expect, it } from "vitest";
import { admitRemoteBackendClient } from "./remoteBackendClientIdentity";

const handshake: RemoteBackendClientHandshake = {
  handshakeRevision: 1,
  clientRpcRevision: 1,
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  backendVersion: "0.1.0",
  capabilities: {
    persistentTerminals: false,
    visibleBrowser: false,
    computerUse: false,
    hostOsIntegration: false,
    mobileAccess: false,
    runtimeUpdates: false,
  },
};
const pin = {
  authority: handshake.authority,
  installationFingerprint: handshake.installationFingerprint,
};

describe("authenticated remote client admission", () => {
  it("accepts only a compatible full client handshake matching the existing pin", () => {
    const input = { ...handshake, internalPath: "/must-not-project", secret: "fixture-only" };
    const result = admitRemoteBackendClient(input, pin);
    expect(result.status).toBe("match");
    if (result.status !== "match") throw new Error("expected admitted handshake");
    expect(result.handshake).toEqual(handshake);
    expect(result.handshake.capabilities.persistentTerminals).toBe(false);
    expect(result.handshake).not.toHaveProperty("secret");
    expect(result.handshake).not.toHaveProperty("internalPath");
  });

  it("never upgrades first contact into trust and does not accept a public mobile descriptor", () => {
    expect(admitRemoteBackendClient(handshake, null)).toEqual({ status: "first-seen" });
    const {
      clientRpcRevision: _revision,
      capabilities: _capabilities,
      ...publicFields
    } = handshake;
    expect(
      admitRemoteBackendClient({ ...publicFields, mobileRpcRevision: 1, mobileCapable: true }, pin),
    ).toEqual({ status: "invalid-handshake" });
  });

  it.each(["handshakeRevision", "clientRpcRevision"] as const)(
    "rejects future %s before interpreting identity/capabilities",
    (field) => {
      const input = {
        ...handshake,
        [field]: 2,
        get authority(): never {
          throw new Error("must not read future identity");
        },
        get capabilities(): never {
          throw new Error("must not read future capabilities");
        },
      };
      expect(admitRemoteBackendClient(input, pin)).toEqual({ status: "unsupported-revision" });
    },
  );

  it.each([
    [null],
    [{}],
    [{ ...handshake, handshakeRevision: 0 }],
    [{ ...handshake, clientRpcRevision: "1" }],
    [{ ...handshake, authority: { ...handshake.authority, authorityId: "wrong" } }],
    [{ ...handshake, capabilities: {} }],
  ])("fails malformed handshake closed", (input) => {
    expect(admitRemoteBackendClient(input, pin)).toEqual({ status: "invalid-handshake" });
  });

  it.each([
    [
      { ...handshake.authority, authorityId: "d".repeat(32) },
      handshake.installationFingerprint,
      "authority-changed",
    ],
    [handshake.authority, `sha256:${"d".repeat(64)}`, "duplicate-authority"],
    [
      { ...handshake.authority, keyEpoch: 2, keyFingerprint: `sha256:${"d".repeat(64)}` },
      handshake.installationFingerprint,
      "key-rotated",
    ],
    [
      { ...handshake.authority, keyEpoch: 1, keyFingerprint: `sha256:${"d".repeat(64)}` },
      handshake.installationFingerprint,
      "key-mismatch",
    ],
    [{ ...handshake.authority, keyEpoch: 2 }, handshake.installationFingerprint, "key-mismatch"],
  ] as const)("preserves identity refusal %s", (authority, installationFingerprint, status) => {
    expect(
      admitRemoteBackendClient({ ...handshake, authority, installationFingerprint }, pin),
    ).toEqual({ status });
  });
});
