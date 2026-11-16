import { expect, it } from "vitest";
import { Schema } from "effect";
import { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake.ts";
import { remoteMobileDescriptor } from "./mobileDescriptor.ts";

it("projects only the existing public-safe descriptor from the persisted identity", () => {
  const identity = {
    authority: {
      authorityId: "a".repeat(32),
      keyEpoch: 2,
      keyFingerprint: `sha256:${"b".repeat(64)}`,
      privateExtension: "never expose",
    },
    installationFingerprint: `sha256:${"c".repeat(64)}`,
    privateKey: "never expose",
    accountPath: "/private/account",
    token: "never expose",
  };
  const publicValue = remoteMobileDescriptor(identity, "0.3.3", false);
  expect(Schema.decodeUnknownSync(RemoteBackendMobileDescriptor)(publicValue)).toEqual(publicValue);
  expect(Object.keys(publicValue).toSorted()).toEqual([
    "authority",
    "backendVersion",
    "handshakeRevision",
    "installationFingerprint",
    "mobileCapable",
    "mobileRpcRevision",
  ]);
  expect(Object.keys(publicValue.authority).toSorted()).toEqual([
    "authorityId",
    "keyEpoch",
    "keyFingerprint",
  ]);
  expect(JSON.stringify(publicValue)).not.toContain("never expose");
  expect(JSON.stringify(publicValue)).not.toContain("/private/account");
  expect(publicValue.authority).not.toBe(identity.authority);
  expect(remoteMobileDescriptor(identity, "0.3.3", true).mobileCapable).toBe(true);
});
