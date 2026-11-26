import {
  verifyRemoteAgentArtifactBytes,
  verifyRemoteAgentArtifactSignature,
} from "./remoteAgentArtifact.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import { assertRemoteAgentControlRoot } from "./remoteAgentControl.root.ts";
import { remoteAgentArtifactIdentity } from "./remoteAgentControl.ops.install.ts";
import {
  makeRemoteAgentOwnerExec,
  type RemoteAgentOwnerControlDependencies,
  type RemoteAgentOwnerOp,
} from "./remoteAgentControl.owner.ts";
import { parseRemoteAgentPlacedState } from "./remoteAgentInstall.inbox.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { buildRemoteAgentInstallPaths } from "./remoteAgentInstall.ts";
import type { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";
import { assertInstalledRemoteAgentCheck } from "./remoteAgentInstallManager.verify.ts";
import { parseRemoteAgentPlatformProbe } from "./remoteAgentPlatform.ts";
import { parseRemoteAgentInventory } from "./remoteAgentUpdate.inventory.ts";

/**
 * U25 production composition of the unchanged legacy install manager and control modules.
 * Each dependency that used to send a script over SSH sends one typed owner operation instead;
 * signature and byte verification stay here exactly as on the legacy path.
 */
const NO_SCRIPT_TEXT = "The production SSH owner runs typed remote agent operations only.";

const stdoutOf = (dependencies: RemoteAgentOwnerControlDependencies, target: string) => {
  const exec = makeRemoteAgentOwnerExec(dependencies, target);
  return async (op: RemoteAgentOwnerOp) => (await exec(op)).stdout;
};

/** The owner-backed control for one target. `run` refuses script text. */
export async function openOwnerRemoteAgentControl(
  dependencies: RemoteAgentOwnerControlDependencies,
  executionTargetId: string,
): Promise<RemoteAgentControl> {
  const exec = stdoutOf(dependencies, executionTargetId);
  const root = (await exec({ kind: "controlRoot" })).trim();
  assertRemoteAgentControlRoot(root);
  const run = async (): Promise<string> => {
    throw new Error(NO_SCRIPT_TEXT);
  };
  return {
    root,
    run,
    exec,
    registry: makeRemoteAgentRegistryStore(root, { run, exec }),
    inventory: async () => parseRemoteAgentInventory(await exec({ kind: "inventory" })),
  };
}

type InstallManagerOverrides = NonNullable<Parameters<typeof makeRemoteAgentInstallManager>[0]>;

/** Install-manager dependencies that route every remote step through the owner. */
export function makeOwnerRemoteAgentInstallDependencies(
  dependencies: RemoteAgentOwnerControlDependencies,
): InstallManagerOverrides {
  return {
    openControl: (target) => openOwnerRemoteAgentControl(dependencies, target),
    probePlatform: async (target) =>
      parseRemoteAgentPlatformProbe(
        await stdoutOf(dependencies, target)({ kind: "platformProbe" }),
      ),
    installArtifact: async (input) => {
      if (!input.skipSignatureVerification)
        verifyRemoteAgentArtifactSignature(input.artifact, input.trustStore);
      verifyRemoteAgentArtifactBytes(input.artifact, input.bytes);
      if (input.artifact.targetTriple !== input.targetTriple)
        throw new Error("Remote agent artifact target does not match the detected target.");
      await stdoutOf(
        dependencies,
        input.executionTargetId,
      )({
        kind: "installUpload",
        artifact: remoteAgentArtifactIdentity(input.artifact),
        reservationId: input.reservationId ?? null,
        bytes: input.bytes,
      });
      return buildRemoteAgentInstallPaths(input.artifact);
    },
    probePlacedArtifact: async (target, artifact) =>
      parseRemoteAgentPlacedState(
        await stdoutOf(
          dependencies,
          target,
        )({
          kind: "placedProbe",
          artifact: remoteAgentArtifactIdentity(artifact),
        }).catch(() => "absent"),
      ),
    adoptPlacedArtifact: async (input) => {
      if (input.artifact.targetTriple !== input.targetTriple)
        throw new Error("Remote agent artifact target does not match the detected target.");
      await stdoutOf(
        dependencies,
        input.executionTargetId,
      )({
        kind: "inboxAdopt",
        artifact: remoteAgentArtifactIdentity(input.artifact),
        reservationId: input.reservationId ?? null,
      });
      return buildRemoteAgentInstallPaths(input.artifact);
    },
    verifyInstalledAgent: async (input) => {
      const stdout = await stdoutOf(
        dependencies,
        input.executionTargetId,
      )({
        kind: "identityCheck",
        artifact: { version: input.version, sha256: identityDigest(input.binaryPath) },
      });
      assertInstalledRemoteAgentCheck(stdout, input);
    },
    runRemoteCommand: async () => {
      throw new Error(NO_SCRIPT_TEXT);
    },
  };
}

/** The managed binary path names its own digest: `…/bin/<version>/<sha256>/bigbud-remote-agent`. */
function identityDigest(binaryPath: string): string {
  const digest = /\/([a-f0-9]{64})\/bigbud-remote-agent$/.exec(binaryPath)?.[1];
  if (!digest) throw new Error("Invalid managed remote agent binary path.");
  return digest;
}
