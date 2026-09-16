import { describe, expect, it } from "vitest";
import { assertRemoteAgentRuntimeHello } from "./remoteAgentCompatibility.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentHello } from "./remoteAgentProtocol.ts";

const digest = "461b7865cd28bb2570d9f580405fa53daee7b51f";
const runtime = {
  version: "0.2.205",
  buildDigest: digest,
  targetTriple: "aarch64-unknown-linux-gnu",
} as RemoteAgentRuntime;
const hello = {
  agentVersion: "0.1.0",
  buildDigest: digest,
  os: "linux",
  architecture: "aarch64",
  agentEpoch: "epoch",
  agentInstanceId: "instance",
  protocolMajor: 1,
  maxFrameBytes: 1024,
  maxJournalBytes: 1024,
  maxOperationOutputBytes: 1024,
} as RemoteAgentHello;

describe("recognized legacy live-version defect", () => {
  it("permits recognized continuity without asserting artifact authenticity", () => {
    expect(() => assertRemoteAgentRuntimeHello(runtime, hello)).not.toThrow();
  });
  it("rejects an arbitrary matching self-reported digest lookalike", () => {
    expect(() =>
      assertRemoteAgentRuntimeHello(
        { ...runtime, buildDigest: "lookalike" },
        { ...hello, buildDigest: "lookalike" },
      ),
    ).toThrow("identity");
  });
  it("still requires exact versions for unrecognized builds", () => {
    expect(() =>
      assertRemoteAgentRuntimeHello(
        { ...runtime, buildDigest: "other" },
        { ...hello, agentVersion: "0.2.205", buildDigest: "other" },
      ),
    ).not.toThrow();
  });
});
