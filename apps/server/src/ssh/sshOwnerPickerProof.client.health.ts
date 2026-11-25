import {
  withPickerReadCancellation,
  type SendPickerCancel,
} from "./sshOwnerPickerProof.client.list.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

export interface PickerProofHealthClient {
  sampleProofHealth(executionTargetId: string): Promise<boolean>;
  sampleCancellableProofHealth(executionTargetId: string, signal: AbortSignal): Promise<boolean>;
}

export function makePickerProofHealthClient(
  targetId: string,
  submit: (
    beforeDispatch?: (id: Uint8Array) => void,
  ) => Promise<Exclude<Outcome, { kind: "error" }>>,
  sendCancel?: SendPickerCancel,
): PickerProofHealthClient {
  const sample = async (executionTargetId: string, beforeDispatch?: (id: Uint8Array) => void) => {
    if (executionTargetId !== targetId) throw new PickerProofOwnerError("invalidOperands");
    const outcome = await submit(beforeDispatch);
    if (outcome.kind !== "proofHealth") throw new PickerProofOwnerError("protocolError");
    return outcome.value;
  };
  return {
    sampleProofHealth: (id) => sample(id),
    sampleCancellableProofHealth: (id, signal) =>
      withPickerReadCancellation(signal, sendCancel, "healthCancelled", (beforeDispatch) =>
        sample(id, beforeDispatch),
      ),
  };
}
