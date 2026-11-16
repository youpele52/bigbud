import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  RemoteBackendClientHandshake,
  REMOTE_BACKEND_CLIENT_HANDSHAKE_REVISION,
  REMOTE_BACKEND_CLIENT_RPC_REVISION,
} from "./remoteBackendClientHandshake";

const descriptor = {
  handshakeRevision: REMOTE_BACKEND_CLIENT_HANDSHAKE_REVISION,
  clientRpcRevision: REMOTE_BACKEND_CLIENT_RPC_REVISION,
  authority: {
    authorityId: "a".repeat(32),
    keyFingerprint: `sha256:${"b".repeat(64)}`,
    keyEpoch: 1,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  backendVersion: "0.1.613",
  capabilities: {
    persistentTerminals: false,
    visibleBrowser: false,
    computerUse: false,
    hostOsIntegration: false,
    mobileAccess: false,
    runtimeUpdates: false,
  },
};

describe("authenticated remote client handshake", () => {
  const decode = Schema.decodeUnknownSync(RemoteBackendClientHandshake);

  it("keeps client revision and unavailable capabilities explicit", () => {
    expect(decode(descriptor)).toEqual(descriptor);
    expect(() => decode({ ...descriptor, capabilities: {} })).toThrow();
    expect(() => decode({ ...descriptor, clientRpcRevision: 0 })).toThrow();
  });

  it("accepts a parseable future revision so clients can refuse it explicitly", () => {
    expect(decode({ ...descriptor, handshakeRevision: 2 }).handshakeRevision).toBe(2);
  });

  it("validates authority and installation identity independently of an origin", () => {
    expect(() =>
      decode({
        ...descriptor,
        authority: { ...descriptor.authority, authorityId: "host.example" },
      }),
    ).toThrow();
    expect(() =>
      decode({ ...descriptor, installationFingerprint: "/home/owner/.bigbud" }),
    ).toThrow();
  });
});
