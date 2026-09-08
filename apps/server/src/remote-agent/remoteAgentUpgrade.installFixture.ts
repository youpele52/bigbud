import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalizeRemoteAgentArtifact } from "./remoteAgentArtifact.ts";
import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";
import { buildRemoteAgentInstallScript } from "./remoteAgentInstall.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type {
  createLinuxControlFixture,
  LinuxFixtureArchitecture,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

/** Sign source-fixture bytes with a disposable test key, never release authenticity evidence. */
export async function installSourceFixture(
  fixture: ReturnType<typeof createLinuxControlFixture>,
  home: string,
  control: RemoteAgentControl,
  bytes: Uint8Array,
  version: string,
  buildDigest: string,
  architecture: LinuxFixtureArchitecture = "aarch64",
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const targetTriple = `${architecture}-unknown-linux-gnu` as const;
  const unsigned = {
    version,
    buildDigest,
    protocolMajor: 1,
    protocolMinor: version === "0.2.205" ? 1 : 2,
    targetTriple,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signature: { algorithm: "ed25519" as const, keyId: "fixture", value: "unsigned" },
    bundledPath: "fixture",
  };
  const artifact = {
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
  return makeRemoteAgentInstallManager({
    runRemoteCommand: async (input) => ({
      stdout: await fixture.run(`export HOME='${home}'; ${input.args?.[1] ?? "exit 1"}`),
    }),
    openControl: async () => control,
    probePlatform: async () => ({
      operatingSystem: "linux",
      architecture,
      targetTriple,
    }),
    readArtifactBytes: async () => bytes,
    installArtifact: async (input) => {
      const script = buildRemoteAgentInstallScript({
        artifact: input.artifact,
        targetTriple: input.targetTriple,
        stagedBase64: Buffer.from(input.bytes).toString("base64"),
        ...(input.reservationId ? { reservationId: input.reservationId } : {}),
      });
      await fixture.runInput(`export HOME='${home}'; ${script.command}`, script.stdin);
      return script.paths;
    },
  }).install({
    executionTargetId: "ssh:fixture",
    source: {
      manifest: { schemaVersion: 1, artifacts: [artifact] },
      trustStore: { fixture: publicKey.export({ type: "spki", format: "pem" }).toString() },
    },
  });
}
