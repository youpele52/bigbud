import {
  AGENT_ACTION_KINDS,
  MAX_AGENT_ACTION_ARTIFACT_BYTES,
  MIN_AGENT_OPERATION_ID_BYTES,
  MAX_AGENT_OPERATION_ID_BYTES,
  type AgentActionArtifact,
  type AgentActionName,
  type AgentActionResult,
  type ProofAgentActionOperation,
} from "./sshOwnerPickerProof.codec.agentAction.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import { invalid, PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

export interface PickerProofAgentActionInput {
  readonly executionTargetId: string;
  readonly action: AgentActionName;
  /** Stable id for this remote operation; reuse it to reattach, never to replay. */
  readonly operationId: Uint8Array;
  readonly artifact?: AgentActionArtifact;
  readonly reattach?: boolean;
}

export type ExecutePickerProofAgentAction = (
  operation: ProofAgentActionOperation,
) => Promise<Outcome>;

export function makePickerProofAgentActionClient(
  targetId: string,
  execute: ExecutePickerProofAgentAction,
) {
  return async function runAgentAction(
    input: PickerProofAgentActionInput,
  ): Promise<AgentActionResult> {
    if (input.executionTargetId !== targetId) throw new PickerProofOwnerError("invalidOperands");
    if (!Object.hasOwn(AGENT_ACTION_KINDS, input.action))
      throw new PickerProofOwnerError("invalidOperands");
    if (
      input.operationId.length < MIN_AGENT_OPERATION_ID_BYTES ||
      input.operationId.length > MAX_AGENT_OPERATION_ID_BYTES
    ) {
      throw new PickerProofOwnerError("invalidOperands");
    }
    if (input.artifact !== undefined && input.artifact.size > MAX_AGENT_ACTION_ARTIFACT_BYTES) {
      throw new PickerProofOwnerError("invalidOperands");
    }
    const outcome = await execute({
      kind: "proofAgentAction",
      action: input.action,
      operationId: input.operationId,
      ...(input.artifact !== undefined ? { artifact: input.artifact } : {}),
      ...(input.reattach === true ? { reattach: true } : {}),
    });
    if (outcome.kind !== "proofAgentAction") return invalid();
    // The owner echoes the exact verb and operation id it accepted.
    if (
      outcome.value.action !== input.action ||
      !Buffer.from(outcome.value.operationId).equals(Buffer.from(input.operationId))
    ) {
      return invalid();
    }
    return outcome.value;
  };
}
