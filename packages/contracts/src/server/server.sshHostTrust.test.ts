import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerTrustSshHostInput, SshHostTrustChallenge } from "./server.sshHostTrust";
import { WsServerTrustSshHostRpc } from "./rpc.sshHostTrust";

describe("SSH host trust contracts", () => {
  it("requires an execution target and opaque approval identity", () => {
    const decode = Schema.decodeUnknownSync(ServerTrustSshHostInput);
    expect(decode({ executionTargetId: "ssh:box", challengeId: "approval-1" })).toEqual({
      executionTargetId: "ssh:box",
      challengeId: "approval-1",
    });
    expect(() => decode({ executionTargetId: "ssh:box", challengeId: " " })).toThrow();
    expect(() => decode({ executionTargetId: "ssh:box" })).toThrow();
  });

  it("validates every field displayed in a trust challenge", () => {
    const decode = Schema.decodeUnknownSync(SshHostTrustChallenge);
    const value = {
      challengeId: "a",
      host: "box:2222",
      keyType: "ED25519",
      fingerprint: "SHA256:abc123",
    };
    expect(decode(value)).toEqual(value);
    expect(() => decode({ ...value, fingerprint: "" })).toThrow();
    expect(() => decode({ challengeId: "a", host: "box" })).toThrow();
  });

  it("exposes a dedicated host-approval RPC rather than treating approval as a password", () => {
    expect(WsServerTrustSshHostRpc._tag).toBe("server.trustSshHost");
  });
});
