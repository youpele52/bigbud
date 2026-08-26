import { type RemoteAgentArtifact } from "./remoteAgentArtifact.ts";
import { type RemoteAgentInstallPaths } from "./remoteAgentInstall.ts";
import {
  buildRemoteAgentActivationCommittedStateScript,
  buildRemoteAgentActivationFailureRecoveryScript,
  buildRemoteAgentActivationFinalizeScript,
  buildRemoteAgentActivationRecoveryScript,
  buildRemoteAgentActivationScript,
} from "./remoteAgentInstall.activation.ts";
import {
  buildOptionalRemoteAgentSupervisorPreparationCommand,
  buildRemoteAgentSupervisorPreparationCommand,
} from "./remoteAgentSupervisor.ts";
import { type RunSshCommandInput } from "../ssh/sshProcess.ts";

function commandStdout(result: unknown): string {
  return typeof result === "object" && result !== null && "stdout" in result
    ? String((result as { stdout?: unknown }).stdout ?? "")
    : "";
}

function validateStatus(result: unknown, valid: readonly string[], operation: string): void {
  if (valid.includes(commandStdout(result).trim())) return;
  throw new Error(`Remote agent ${operation} returned an invalid status.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runRemoteAgentActivationTransaction(input: {
  readonly executionTargetId: string;
  readonly artifact: RemoteAgentArtifact;
  readonly paths: RemoteAgentInstallPaths;
  readonly runRemoteCommand: (input: RunSshCommandInput) => Promise<unknown>;
  readonly verifyInstalledAgent: (input: {
    readonly executionTargetId: string;
    readonly version: string;
    readonly buildDigest: string;
    readonly protocolMajor: number;
    readonly protocolMinor: number;
  }) => Promise<void>;
}): Promise<void> {
  const runScript = (script: string) =>
    input.runRemoteCommand({
      executionTargetId: input.executionTargetId,
      command: "sh",
      args: ["-lc", script],
      timeoutMs: 30_000,
      maxBufferBytes: 64 * 1024,
      outputMode: "error",
    });

  const verifyCandidateIdentity = () =>
    input.verifyInstalledAgent({
      executionTargetId: input.executionTargetId,
      version: input.artifact.version,
      protocolMajor: input.artifact.protocolMajor,
      protocolMinor: input.artifact.protocolMinor,
      buildDigest: input.artifact.buildDigest,
    });

  let activationChanged = false;

  try {
    const activation = await runScript(buildRemoteAgentActivationScript(input.artifact));
    validateStatus(activation, ["activated", "unchanged"], "activation");
    activationChanged = commandStdout(activation).trim() === "activated";
    await verifyCandidateIdentity();
    await runScript(buildRemoteAgentSupervisorPreparationCommand(input.paths.activeLink));
    try {
      await finalizeActivation(runScript, input.artifact);
    } catch (finalizationError) {
      const state = await runScript(buildRemoteAgentActivationCommittedStateScript(input.artifact));
      validateStatus(state, ["active", "pending", "baseline"], "committed-state probe");
      if (commandStdout(state).trim() === "active") {
        await verifyCandidateIdentity();
        return;
      }
      throw finalizationError;
    }
  } catch (error) {
    try {
      const recovery = await runScript(
        activationChanged
          ? buildRemoteAgentActivationFailureRecoveryScript(input.artifact)
          : buildRemoteAgentActivationRecoveryScript(input.artifact),
      );
      const status = commandStdout(recovery).trim();
      if (
        status !== "restored" &&
        status !== "removed" &&
        status !== "unchanged" &&
        status !== "baseline"
      ) {
        throw new Error("Remote agent recovery returned an invalid status.", { cause: error });
      }
      if (status === "restored") {
        await runScript(
          buildOptionalRemoteAgentSupervisorPreparationCommand(input.paths.activeLink),
        );
      }
    } catch (recoveryError) {
      throw new Error(
        `Remote agent candidate failed verification and rollback failed: ${errorMessage(recoveryError)}`,
        { cause: recoveryError },
      );
    }
    throw new Error(`Remote agent candidate failed verification: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

async function finalizeActivation(
  runScript: (script: string) => Promise<unknown>,
  artifact: RemoteAgentArtifact,
): Promise<void> {
  const script = buildRemoteAgentActivationFinalizeScript(artifact);
  try {
    validateStatus(await runScript(script), ["finalized", "unchanged"], "finalization");
  } catch (firstError) {
    try {
      validateStatus(await runScript(script), ["finalized", "unchanged"], "finalization");
    } catch (reconciliationError) {
      throw new Error(
        `Remote agent finalization could not be reconciled after '${errorMessage(firstError)}': ${errorMessage(reconciliationError)}`,
        { cause: reconciliationError },
      );
    }
  }
}
