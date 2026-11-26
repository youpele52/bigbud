import {
  buildRemoteAgentRegistryCas,
  buildRemoteAgentRegistryRead,
} from "./remoteAgentInstall.registry.shell.ts";
import { REMOTE_AGENT_BACKEND_RUNTIME_PROBE } from "./remoteAgentInstall.remove.blockers.ts";
import {
  buildRemoteAgentRemovalCommand,
  buildRemoteAgentRemovalOutcomeProbe,
} from "./remoteAgentInstall.remove.deletion.ts";
import { buildRemoteAgentRetirementDeletionCommand } from "./remoteAgentInstall.retirement.deletion.ts";
import { buildRemoteAgentOrphanDeletionCommand } from "./remoteAgentInstall.orphan.ts";
import { buildRemoteAgentStageFenceRevokeCommand } from "./remoteAgentInstall.stageFence.ts";
import { buildRemoteAgentRuntimeProbeCommand } from "./remoteAgentConnection.identity.ts";
import {
  buildRemoteAgentAdmissionDeathObservation,
  buildRemoteAgentLaunchExitObservation,
  buildRemoteAgentRawSupervisorObservation,
  buildRemoteAgentSocketGoneWait,
  buildRemoteAgentSocketLiveProbe,
  buildRemoteAgentStateAbsentProbe,
  buildRemoteAgentSupervisorExitAwait,
  buildRemoteAgentSupervisorStateProbe,
  REMOTE_AGENT_CONTROL_ROOT_SCRIPT,
  REMOTE_AGENT_HOST_CLOCK_SCRIPT,
} from "./remoteAgentControl.scripts.ts";
import {
  buildIsolatedRemoteAgentLaunch,
  buildManagedRemoteAgentReplacementLaunch,
  buildRemoteAgentReplacementDeathEvidence,
  buildRemoteAgentReplacementReadiness,
} from "./remoteAgentRuntime.launch.ts";
import {
  buildRemoteAgentSupervisorRestartCommand,
  buildRemoteAgentSupervisorShutdownCommand,
} from "./remoteAgentSupervisor.ts";
import {
  buildRemoteAgentCandidateExitWaitCommand,
  buildRemoteAgentCandidateStartupWaitCommand,
} from "./remoteAgentUpdate.prepare.scripts.ts";
import { buildRemoteAgentInventoryCommand } from "./remoteAgentUpdate.inventory.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

/**
 * U25: every remote-agent control transaction as a typed operation. The legacy
 * control compiles an operation with the existing builders (byte-identical
 * scripts); the production control sends it to the SSH owner as one
 * `agent_control` kind with data operands only. The control root is never an
 * operand: the owner recomputes it on the host.
 */
export type RemoteAgentSupervisorObservationMode =
  | "retirementState"
  | "retirementExit"
  | "launchExit"
  | "raw"
  | "candidateStartup"
  | "candidateExit"
  | "replacementReadiness"
  | "replacementDeath";

export type RemoteAgentControlOp =
  | { readonly kind: "controlRoot" }
  | { readonly kind: "registryRead" }
  | { readonly kind: "registryCas"; readonly expected: string | null; readonly next: string }
  | { readonly kind: "stageFenceRevoke"; readonly reservationId: string }
  | { readonly kind: "inventory" }
  | {
      readonly kind: "supervisorObserve";
      readonly mode: RemoteAgentSupervisorObservationMode;
      readonly runtime: RemoteAgentRuntime;
      readonly attemptId: string;
    }
  | {
      readonly kind: "admissionDeathObserve";
      readonly runtime: RemoteAgentRuntime;
      readonly attemptId: string;
      readonly epoch: string;
    }
  | { readonly kind: "stateAbsent"; readonly runtime: RemoteAgentRuntime }
  | { readonly kind: "supervisorShutdown"; readonly runtime: RemoteAgentRuntime }
  | { readonly kind: "supervisorRestart"; readonly runtime: RemoteAgentRuntime }
  | {
      readonly kind: "isolatedLaunch";
      readonly runtime: RemoteAgentRuntime;
      readonly attemptId: string;
    }
  | {
      readonly kind: "replacementLaunch";
      readonly runtime: RemoteAgentRuntime;
      readonly attemptId: string;
      readonly oldEpoch: string;
      readonly oldAttemptId: string;
    }
  | { readonly kind: "retirementDelete"; readonly runtime: RemoteAgentRuntime }
  | { readonly kind: "removal"; readonly fenceId: string }
  | { readonly kind: "removalResume" }
  | { readonly kind: "removalOutcome" }
  | { readonly kind: "hostClock" }
  | { readonly kind: "orphanDelete"; readonly version: string; readonly digest: string }
  | { readonly kind: "backendRuntimeProbe" }
  | { readonly kind: "socketLive"; readonly runtime: RemoteAgentRuntime }
  | { readonly kind: "socketGone"; readonly runtime: RemoteAgentRuntime }
  | { readonly kind: "runtimeProbe"; readonly binaryPath: string | null };

export type RemoteAgentControlKind = RemoteAgentControlOp["kind"];

/** The default selector a legacy runtime probe reads when no external binary is named. */
export const REMOTE_AGENT_DEFAULT_BINARY = "$HOME/.bigbud/agent/bin/current";
const REMOVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** Legacy command deadline per operation; the owner applies the same one per kind. */
export function remoteAgentControlTimeoutMs(op: RemoteAgentControlOp): number | undefined {
  return op.kind === "removal" || op.kind === "removalResume" ? REMOVAL_TIMEOUT_MS : undefined;
}

function observation(
  mode: RemoteAgentSupervisorObservationMode,
  runtime: RemoteAgentRuntime,
  attemptId: string,
): string {
  switch (mode) {
    case "retirementState":
      return buildRemoteAgentSupervisorStateProbe(runtime, attemptId);
    case "retirementExit":
      return buildRemoteAgentSupervisorExitAwait(runtime, attemptId);
    case "launchExit":
      return buildRemoteAgentLaunchExitObservation(runtime, attemptId);
    case "raw":
      return buildRemoteAgentRawSupervisorObservation(runtime, attemptId);
    case "candidateStartup":
      return buildRemoteAgentCandidateStartupWaitCommand(runtime, attemptId);
    case "candidateExit":
      return buildRemoteAgentCandidateExitWaitCommand(runtime, attemptId);
    case "replacementReadiness":
      return buildRemoteAgentReplacementReadiness(runtime, attemptId);
    case "replacementDeath":
      return buildRemoteAgentReplacementDeathEvidence(runtime, attemptId);
  }
}

/** Compile one operation into the legacy script for the given control root. */
export function compileRemoteAgentControlOp(root: string, op: RemoteAgentControlOp): string {
  switch (op.kind) {
    case "controlRoot":
      return REMOTE_AGENT_CONTROL_ROOT_SCRIPT;
    case "registryRead":
      return buildRemoteAgentRegistryRead(root);
    case "registryCas":
      return buildRemoteAgentRegistryCas({ root, expected: op.expected, next: op.next });
    case "stageFenceRevoke":
      return buildRemoteAgentStageFenceRevokeCommand(root, op.reservationId);
    case "inventory":
      return buildRemoteAgentInventoryCommand(root);
    case "supervisorObserve":
      return observation(op.mode, op.runtime, op.attemptId);
    case "admissionDeathObserve":
      return buildRemoteAgentAdmissionDeathObservation(op.runtime, op.attemptId, op.epoch);
    case "stateAbsent":
      return buildRemoteAgentStateAbsentProbe(op.runtime.statePath);
    case "supervisorShutdown":
      return buildRemoteAgentSupervisorShutdownCommand(op.runtime);
    case "supervisorRestart":
      return buildRemoteAgentSupervisorRestartCommand(op.runtime);
    case "isolatedLaunch":
      return buildIsolatedRemoteAgentLaunch(op.runtime, op.attemptId);
    case "replacementLaunch":
      return buildManagedRemoteAgentReplacementLaunch(
        op.runtime,
        op.attemptId,
        op.oldEpoch,
        op.oldAttemptId,
      );
    case "retirementDelete":
      return buildRemoteAgentRetirementDeletionCommand(op.runtime);
    case "removal":
      return buildRemoteAgentRemovalCommand(root, { mode: "remove", fenceId: op.fenceId });
    case "removalResume":
      return buildRemoteAgentRemovalCommand(root, { mode: "resume" });
    case "removalOutcome":
      return buildRemoteAgentRemovalOutcomeProbe(root);
    case "hostClock":
      return REMOTE_AGENT_HOST_CLOCK_SCRIPT;
    case "orphanDelete":
      return buildRemoteAgentOrphanDeletionCommand({
        root,
        version: op.version,
        digest: op.digest,
        binaryPath: `${root}/bin/${op.version}/${op.digest}/bigbud-remote-agent`,
      });
    case "backendRuntimeProbe":
      return REMOTE_AGENT_BACKEND_RUNTIME_PROBE;
    case "socketLive":
      return buildRemoteAgentSocketLiveProbe(op.runtime.socketPath);
    case "socketGone":
      return buildRemoteAgentSocketGoneWait(op.runtime.socketPath);
    case "runtimeProbe":
      return buildRemoteAgentRuntimeProbeCommand(op.binaryPath ?? REMOTE_AGENT_DEFAULT_BINARY);
  }
}

/** The narrow control surface an operation runs on. */
export interface RemoteAgentControlRunner {
  /** Required for root-scoped operations; runtime-scoped ones never read it. */
  readonly root?: string;
  run: (command: string, options?: { readonly timeoutMs?: number }) => Promise<string>;
  /** Production controls run typed operations; legacy controls leave this unset. */
  readonly exec?: (op: RemoteAgentControlOp) => Promise<string>;
}

/** Run one typed control operation on a legacy or production control. */
export function runRemoteAgentControlOp(
  control: RemoteAgentControlRunner,
  op: RemoteAgentControlOp,
): Promise<string> {
  if (control.exec) return control.exec(op);
  const timeoutMs = remoteAgentControlTimeoutMs(op);
  const script = compileRemoteAgentControlOp(control.root ?? "", op);
  return timeoutMs === undefined ? control.run(script) : control.run(script, { timeoutMs });
}
