import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  readExternalV2Target,
  withProductionV2Owner,
  type ExternalV2Target,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { PickerProofBoundTarget } from "../ssh/sshOwnerPickerProof.client.session.types.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import {
  canonicalizeRemoteAgentArtifact,
  remoteAgentTargetCandidates,
  selectRemoteAgentArtifact,
} from "./remoteAgentArtifact.ts";
import { downloadRemoteAgentArtifact } from "./remoteAgentArtifactDownload.ts";
import { makeRemoteAgentInstallSourceLoader } from "./remoteAgentInstallSource.ts";
import type { RemoteAgentOwnerControlDependencies } from "./remoteAgentControl.owner.ts";
import { REMOTE_AGENT_PROTOCOL_MAJOR, REMOTE_AGENT_PROTOCOL_MINOR } from "./remoteAgentProtocol.ts";

/**
 * U25 live fixture: a real production owner (target/debug/bigbud-ssh-owner) against a disposable
 * non-root Linux account (the OrbStack Debian guest in a private mount namespace with a tmpfs
 * home), and cross-built agent bytes.
 *
 * EVIDENCE LABEL: the agent bytes are a LOCAL BUILD, NOT RELEASE-TRUSTED (E7 open). They are
 * signed here with a disposable key, so this proves the verification path, not release origin.
 *
 * BIGBUD_TEST_TAGENT_EXTERNAL_TARGET='{"host":…,"port":…,"user":…,"identityFile":…,
 *   "knownHostsFile":…,"cwd":"/tmp","remoteBinary":"/unused"}'
 * BIGBUD_TEST_TAGENT_AGENTS='[{"path":…,"version":…,"buildDigest":…}, …]' (aarch64 builds)
 */
export const external = readExternalV2Target(process.env.BIGBUD_TEST_TAGENT_EXTERNAL_TARGET);
const agents = JSON.parse(process.env.BIGBUD_TEST_TAGENT_AGENTS ?? "[]") as ReadonlyArray<{
  readonly path: string;
  readonly version: string;
  readonly buildDigest: string;
}>;
/**
 * Release mode (E7, C2): BIGBUD_TEST_TAGENT_RELEASES='["0.4.1-beta.1", …]' (three published
 * releases). Each source comes from the normal release loader (pinned release keys, no trust
 * override) and the bytes from the normal artifact download.
 */
const releases = JSON.parse(
  process.env.BIGBUD_TEST_TAGENT_RELEASES ?? "[]",
) as ReadonlyArray<string>;
export const releaseMode = releases.length >= 3;
export const liveReady = external !== undefined && (agents.length >= 3 || releaseMode);
export const LABEL = releaseMode
  ? `release v${releases[0]}, pinned release key`
  : "local build, not release-trusted (E7 open)";

export type LiveBuild = ReturnType<typeof signedBuild>;

/** The build a Debian aarch64 (glibc) host selects from release `index`, or a local signed build. */
export async function liveBuild(index: number): Promise<LiveBuild> {
  if (!releaseMode) return signedBuild(index);
  const source = await makeRemoteAgentInstallSourceLoader(releaseEnvironment(index))();
  const artifact = selectRemoteAgentArtifact(
    source.manifest,
    remoteAgentTargetCandidates("aarch64-unknown-linux-gnu", "glibc"),
  );
  const bytes = await downloadRemoteAgentArtifact(artifact);
  return { artifact, bytes, source } as unknown as LiveBuild;
}

/** The normal release-source environment for release `index` (no install-source override). */
export function releaseEnvironment(index: number): NodeJS.ProcessEnv {
  return { ...process.env, BIGBUD_REMOTE_AGENT_RELEASE_VERSION: releases[index]! };
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

/** One signed build: manifest entry, bytes and the install source the manager consumes. */
export function signedBuild(index: number) {
  const agent = agents[index]!;
  const bytes = readFileSync(agent.path);
  const unsigned = {
    version: agent.version,
    buildDigest: agent.buildDigest,
    protocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
    protocolMinor: REMOTE_AGENT_PROTOCOL_MINOR,
    targetTriple: "aarch64-unknown-linux-gnu" as const,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signature: { algorithm: "ed25519" as const, keyId: "e7-open-local", value: "" },
    bundledPath: "local-e7-open",
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
  return {
    artifact,
    bytes: new Uint8Array(bytes),
    source: {
      manifest: { schemaVersion: 1 as const, artifacts: [artifact] },
      trustStore: {
        "e7-open-local": publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    },
  };
}

/** Test-harness SSH (not product code): place or inspect files on the disposable account. */
export function harnessShell(target: ExternalV2Target, script: string, input?: Uint8Array): string {
  return execFileSync(
    "ssh",
    [
      "-F",
      "/dev/null",
      "-i",
      target.identityFile,
      "-o",
      `UserKnownHostsFile=${target.knownHostsFile}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-p",
      String(target.port),
      `${target.user}@${target.host}`,
      script,
    ],
    { input, encoding: "utf8" },
  );
}

export interface OwnerLive {
  readonly bound: PickerProofBoundTarget;
  readonly targetId: string;
  readonly live: RemoteAgentOwnerControlDependencies;
}

/** Run with an approved production owner bound to the external target. */
export function withOwner<A>(run: (live: OwnerLive) => Promise<A>): Promise<A> {
  return withProductionV2Owner(external!, 1, async ({ handle, targets }) => {
    const { descriptor } = targets[0]!;
    const bound = handle.target(descriptor);
    const trust = await bound.inspectTrust();
    if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
    const registration = {
      handle,
      descriptorFor: async () => descriptor,
    } as unknown as SshOwnerProductionRegistration;
    return run({
      bound,
      targetId: descriptor.targetId,
      live: { owner: () => registration, pollMs: { first: 10, max: 250 } },
    });
  });
}
