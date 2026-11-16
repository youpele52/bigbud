import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";
import { canonicalizeMobileOptionalArtifact } from "@bigbud/shared/mobileOptionalArtifact";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import type { MobileStageContext } from "./remoteAgentInstall.mobile.transitions.ts";

const keys = generateKeyPairSync("ed25519");
export function mobileFixture(version = "1") {
  const gatewayBytes = Buffer.from("test-only gateway " + version);
  const assetsBytes = Buffer.from("test-only assets " + version);
  function artifact(
    kind: "mobile-gateway" | "mobile-assets",
    bytes: Buffer,
  ): MobileOptionalArtifact {
    const record: MobileOptionalArtifact = {
      schemaVersion: 1,
      ...(kind === "mobile-gateway"
        ? { kind, format: "executable", targetTriple: "aarch64-unknown-linux-musl" }
        : { kind, format: "tar.gz", targetTriple: "portable" }),
      compatibility: {
        agentVersion: "0.2.207",
        backendVersion: "0.1.fixture",
        gatewayVersion: version,
        mobileAssetVersion: version,
        minimumMobileRpcRevision: 1,
        maximumMobileRpcRevision: 1,
      },
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      url: `https://github.com/example/releases/download/fixture-${version}/${kind}`,
      signature: { algorithm: "ed25519", keyId: "fixture", value: "" },
    };
    return {
      ...record,
      signature: {
        ...record.signature,
        value: sign(
          null,
          Buffer.from(canonicalizeMobileOptionalArtifact(record)),
          keys.privateKey,
        ).toString("base64"),
      },
    };
  }
  const context: MobileStageContext = {
    owner: {
      authority: {
        authorityId: "a".repeat(32),
        keyEpoch: 1,
        keyFingerprint:
          "sha256:" +
          createHash("sha256")
            .update(keys.publicKey.export({ type: "spki", format: "der" }))
            .digest("hex"),
      },
      installationFingerprint: "sha256:" + "b".repeat(64),
    },
    expectedConsentRevision: 1,
    controller: { id: "fixture-controller", pid: 1234, startedAt: "fixture-start-token" },
    host: {
      targetTriple: "aarch64-unknown-linux-musl",
      agentVersion: "0.2.207",
      backendVersion: "0.1.fixture",
      mobileRpcRevision: 1,
    },
    trustedKeys: { fixture: keys.publicKey.export({ type: "spki", format: "pem" }).toString() },
  };
  return {
    context,
    request: {
      id: "fixture-stage",
      gateway: artifact("mobile-gateway", gatewayBytes),
      assets: artifact("mobile-assets", assetsBytes),
    },
    gatewayBytes,
    assetsBytes,
  };
}

/** Exercises the real store's command protocol, not filesystem durability (Linux test does that). */
export function memoryRegistryCommand(initial?: RemoteAgentRegistry) {
  let text = initial ? JSON.stringify(initial) : null;
  let loseAck = false;
  let beforeCas: ((state: RemoteAgentRegistry) => RemoteAgentRegistry) | null = null;
  return {
    read: () =>
      text === null ? emptyRemoteAgentRegistry() : (JSON.parse(text) as RemoteAgentRegistry),
    loseNextAck: () => {
      loseAck = true;
    },
    beforeNextCas: (transition: (state: RemoteAgentRegistry) => RemoteAgentRegistry) => {
      beforeCas = transition;
    },
    run: async (command: string): Promise<string> => {
      if (!command.includes("printf committed"))
        return text === null ? "missing" : Buffer.from(text).toString("base64");
      if (beforeCas) {
        const transition = beforeCas;
        beforeCas = null;
        text = JSON.stringify(
          transition(
            text === null ? emptyRemoteAgentRegistry() : (JSON.parse(text) as RemoteAgentRegistry),
          ),
        );
      }
      const expectedEncoded = command.match(
        /printf '%s' '([A-Za-z0-9+/=]*)' \| base64 --decode > "\$expected"/,
      )?.[1];
      const nextEncoded = command.match(
        /printf '%s' '([A-Za-z0-9+/=]*)' \| base64 --decode > "\$next"/,
      )?.[1];
      if (expectedEncoded === undefined || nextEncoded === undefined)
        throw new Error("Unknown fixture CAS protocol.");
      const expected =
        expectedEncoded === "" ? null : Buffer.from(expectedEncoded, "base64").toString("utf8");
      if (expected !== text) return "conflict";
      text = Buffer.from(nextEncoded, "base64").toString("utf8");
      if (loseAck) {
        loseAck = false;
        throw new Error("fixture lost CAS acknowledgement");
      }
      return "committed";
    },
  };
}
