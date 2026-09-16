import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  canonicalizeRemoteAgentArtifact,
  resolveRemoteAgentTargetTriple,
} from "./remoteAgentArtifact.ts";
import { openRemoteAgentControl } from "./remoteAgentControl.ts";
import { parseRemoteAgentCheckOutput } from "./remoteAgentIdentity.ts";
import { buildRemoteAgentInstallScript } from "./remoteAgentInstall.ts";
import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";
import type { createLinuxControlFixture } from "./remoteAgentUpgrade.linux.fixtures.ts";

/** Exercises production shell/CAS with disposable signing keys, not release authenticity. */
export async function createRemoteAgentSetupFixture(
  fixture: ReturnType<typeof createLinuxControlFixture>,
  binaryPath: string,
) {
  if (!fixture.container)
    throw new Error("The setup fixture requires its isolated Docker container.");
  execFileSync("docker", ["cp", binaryPath, `${fixture.container}:/tmp/source-agent`]);
  const identity = parseRemoteAgentCheckOutput(await fixture.run("/tmp/source-agent --check"));
  const targetTriple = resolveRemoteAgentTargetTriple(
    identity.operatingSystem,
    identity.architecture,
  );
  if (!targetTriple) throw new Error("The setup fixture binary must target supported Linux.");
  const home = "/tmp/setup-home";
  await fixture.run(`mkdir -m 700 '${home}' /tmp/workspace`);
  const execute = async (input: { readonly args?: ReadonlyArray<string> }) => ({
    stdout: await fixture.run(`export HOME='${home}'; ${input.args?.[1] ?? "exit 1"}`),
  });
  const target = "ssh:host=fixture&transport=agent";
  const control = await openRemoteAgentControl(target, execute);
  const bytes = readFileSync(binaryPath);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const unsigned = {
    version: identity.version,
    buildDigest: identity.buildDigest,
    protocolMajor: identity.protocolMajor,
    protocolMinor: identity.protocolMinor,
    targetTriple,
    sizeBytes: bytes.length,
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
  const source = {
    manifest: { schemaVersion: 1 as const, artifacts: [artifact] },
    trustStore: { fixture: publicKey.export({ type: "spki", format: "pem" }).toString() },
  };
  const manager = makeRemoteAgentInstallManager({
    runRemoteCommand: execute,
    openControl: async () => control,
    probePlatform: async () => ({
      operatingSystem: identity.operatingSystem,
      architecture: identity.architecture,
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
  });
  return { target, control, artifact, source, manager };
}
