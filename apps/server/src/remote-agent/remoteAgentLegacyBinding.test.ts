import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeRemoteAgentArtifact,
  type RemoteAgentArtifact,
} from "./remoteAgentArtifact.ts";
import { emptyRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { observeLegacyRemoteAgentBinding } from "./remoteAgentLegacyBinding.ts";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";

const digest = "461b7865cd28bb2570d9f580405fa53daee7b51f";

function artifact() {
  const bytes = Buffer.from("legacy-205");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const unsigned: RemoteAgentArtifact = {
    version: "0.2.205",
    buildDigest: digest,
    protocolMajor: 1,
    protocolMinor: 1,
    targetTriple: "aarch64-unknown-linux-gnu",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signature: { algorithm: "ed25519", keyId: "historical", value: "" },
    bundledPath: "fixtures/legacy-205",
  };
  const signed = {
    ...unsigned,
    signature: {
      ...unsigned.signature,
      value: sign(
        null,
        Buffer.from(canonicalizeRemoteAgentArtifact(unsigned)),
        privateKey,
      ).toString("base64"),
    },
  };
  return {
    artifact: signed,
    trustStore: { historical: publicKey.export({ type: "spki", format: "pem" }).toString() },
  };
}

function connection(): RemoteAgentConnection {
  const value = Object.create(RemoteAgentConnection.prototype) as RemoteAgentConnection;
  value.handshake = async () => ({
    protocolMajor: 1,
    protocolMinor: 1,
    agentVersion: "0.1.0",
    buildDigest: digest,
    os: "linux",
    architecture: "aarch64",
    agentInstanceId: "legacy-instance",
    agentEpoch: "legacy-epoch",
    capabilities: [],
    maxFrameBytes: 1024,
    maxOperationOutputBytes: 1024,
    maxJournalBytes: 1024,
  });
  value.request = async () => ({
    type: "diagnosticResponse",
    value: {
      requestId: "ignored",
      operationId: "ignored",
      accepted: true,
      terminal: true,
      message: "agent-ready",
    },
  });
  value.close = () => undefined;
  return value;
}

function control(output: string): RemoteAgentControl {
  let state = emptyRemoteAgentRegistry();
  return {
    root: "/home/test/.bigbud/agent",
    run: async () => output,
    registry: {
      read: async () => state,
      update: async (transition) => {
        state = transition(state);
        return state;
      },
    } as RemoteAgentControl["registry"],
  };
}

describe("legacy 0.2.205 provenance", () => {
  it("authenticates only a signed historical identity plus matching live evidence", async () => {
    const trusted = artifact();
    const observed = await observeLegacyRemoteAgentBinding(
      "fixture",
      control(
        "/home/test/.bigbud/agent/bin/legacy-205\n" +
          `${trusted.artifact.sha256}\n` +
          "bigbud-remote-agent 0.2.205 1 1 461b7865cd28bb2570d9f580405fa53daee7b51f linux aarch64\n",
      ),
      connection,
      trusted,
    );
    expect(observed?.runtime.version).toBe("0.2.205");
    expect(observed?.runtime.origin).toBe("legacy-external");
  });

  it("keeps the legacy route unauthenticated when trusted history is unavailable", async () => {
    const trusted = artifact();
    const observed = await observeLegacyRemoteAgentBinding(
      "fixture",
      control(
        "/home/test/.bigbud/agent/bin/legacy-205\n" +
          `${trusted.artifact.sha256}\n` +
          "bigbud-remote-agent 0.2.205 1 1 461b7865cd28bb2570d9f580405fa53daee7b51f linux aarch64\n",
      ),
      connection,
    );
    expect(observed?.runtime.version).toBe("0.2.205");
  });
});
