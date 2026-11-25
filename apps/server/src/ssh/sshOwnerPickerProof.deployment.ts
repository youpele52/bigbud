import type { DeploymentManifestRequest } from "../remote-backend/deployment.ssh.owner.manifest.ts";
import type {
  DeploymentGraphStageBeginRequest,
  DeploymentHostProbeRequest,
  DeploymentCompletionRequest,
  DeploymentHostProbeOutcome,
  DeploymentSshOwner,
} from "../remote-backend/deployment.ssh.owner.ts";
import {
  classifyDeploymentOutcome,
  validateDeploymentStep,
  type DeploymentStepOutcome,
  type DeploymentStepRequest,
} from "../remote-backend/deployment.ssh.owner.operations.ts";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { ProofDeploymentProbeResult } from "./sshOwnerPickerProof.codec.deployment.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import { invalid, PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

export type ProofDeploymentInput =
  | DeploymentHostProbeRequest
  | DeploymentCompletionRequest
  | DeploymentGraphStageBeginRequest
  | DeploymentManifestRequest
  | DeploymentStepRequest;

export interface PickerProofDeploymentClient {
  readProofDeployment(input: ProofDeploymentInput): Promise<ProofDeploymentProbeResult>;
}

function isStepInput(input: ProofDeploymentInput): input is DeploymentStepRequest {
  return "action" in input && typeof input.action === "string";
}

export function makePickerProofDeploymentClient(
  targetId: string,
  execute: (operation: PickerProofOperation) => Promise<Exclude<Outcome, { kind: "error" }>>,
): PickerProofDeploymentClient {
  return {
    async readProofDeployment(input) {
      if (isStepInput(input)) {
        if (input.executionTargetId !== targetId)
          throw new PickerProofOwnerError("invalidOperands");
        validateDeploymentStep(input);
        const outcome = await execute({ kind: "proofDeploymentAction", ...input });
        return outcome.kind === "proofDeploymentHostResult" ? outcome.value : invalid();
      }
      const { executionTargetId, action } = input;
      if (executionTargetId !== targetId) throw new PickerProofOwnerError("invalidOperands");
      const outcome = await execute(
        action.kind === "probeHost"
          ? { kind: "proofDeploymentHostProbe", deploymentRequestId: action.requestId }
          : action.kind === "beginGraphStage"
            ? { ...action, kind: "proofDeploymentStageBegin" }
            : action.kind === "putGraphManifest"
              ? {
                  ...action,
                  kind: "proofDeploymentManifestPut",
                  contents: Uint8Array.from(action.contents),
                }
              : {
                  kind: "proofDeploymentCompletion",
                  deploymentRequestId: action.requestId,
                  authorityId: action.authorityId,
                },
      );
      return outcome.kind === "proofDeploymentHostResult" ? outcome.value : invalid();
    },
  };
}

type Failure = Extract<DeploymentHostProbeOutcome, { kind: "failed" }>["reason"];
function classifyFailure(cause: unknown): Failure {
  if (!(cause instanceof PickerProofOwnerError)) return "unavailable";
  switch (cause.code) {
    case "trustRequired":
    case "hostKeyChanged":
      return "trust-refused";
    case "operationDenied":
    case "invalidOperands":
    case "targetDisconnected":
      return "approval-refused";
    case "proofDeploymentTimeout":
      return "timeout";
    case "proofDeploymentOutputLimit":
      return "output-limit";
    case "configUnsupported":
    case "versionIncompatible":
      return "unsupported";
    default:
      return "unavailable";
  }
}

const STEP_STATES = ["started", "completed", "cancelled", "outcomeUnknown", "refused"] as const;

function stepState(value: number | undefined) {
  if (value === undefined || value < 1 || value > STEP_STATES.length) return undefined;
  return STEP_STATES[value - 1];
}

/** Only for the isolated proof owner; cancellation rejects delivery, not remote process termination. */
export function deploymentForPickerProof(
  client: PickerProofDeploymentClient,
  { fixtureStage = false, typedSteps = false } = {},
): DeploymentSshOwner {
  async function run(
    input: Parameters<PickerProofDeploymentClient["readProofDeployment"]>[0],
    signal: AbortSignal,
  ): Promise<DeploymentHostProbeOutcome> {
    signal.throwIfAborted();
    try {
      const result = await client.readProofDeployment(input);
      signal.throwIfAborted();
      return { kind: "exited", ...result };
    } catch (cause) {
      signal.throwIfAborted();
      return { kind: "failed", reason: classifyFailure(cause) };
    }
  }
  async function step(
    request: DeploymentStepRequest,
    signal: AbortSignal,
  ): Promise<DeploymentStepOutcome> {
    signal.throwIfAborted();
    const result = await client.readProofDeployment(request);
    signal.throwIfAborted();
    return classifyDeploymentOutcome(
      request,
      {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        state: stepState(result.state),
      },
      request.action === "reattach",
    );
  }
  return {
    deploymentAction: run,
    ...(fixtureStage ? { beginGraphStage: run, putGraphManifest: run } : {}),
    ...(typedSteps ? { deploymentStep: step } : {}),
  };
}
