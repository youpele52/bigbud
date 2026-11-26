import type { BoundedInitiatingGitTransport } from "../git/Layers/GitCore.initiatingPush.composition.ts";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

export interface PickerProofTrackedGitClient extends BoundedInitiatingGitTransport {
  /** Opaque epoch-bound generation for a trusted isolated approval producer. */
  readonly trackedGitTargetGeneration: string;
}

/** No raw bytes, Git arguments, command launcher or fallback cross this boundary. */
export function makeProofTrackedGitClient(
  targetId: string,
  generation: () => Uint8Array,
  execute: (
    operation: PickerProofOperation,
    beforeDispatch?: () => void,
  ) => Promise<Exclude<Outcome, { kind: "error" }>>,
): PickerProofTrackedGitClient {
  const denied = { status: "deniedBeforeDispatch" } as const;
  const token = () => Buffer.from(generation()).toString("hex");
  return {
    get trackedGitTargetGeneration() {
      return token();
    },
    async receiveTrackedPush(request, signal) {
      const [destination] = request.destinations;
      if (
        signal.aborted ||
        request.direction !== "push" ||
        request.destinations.length !== 1 ||
        !destination ||
        destination.executionTargetId !== targetId ||
        destination.targetGeneration !== token()
      )
        return denied;
      const receiptIdentity = {
        index: 0,
        effectiveUrl: destination.effectiveUrl,
        executionTargetId: targetId,
        targetGeneration: destination.targetGeneration,
      };
      let dispatched = false;
      try {
        const result = await execute(
          {
            kind: "proofGitTrackedPush",
            direction: "push",
            repository: { ...request.repository },
            remoteName: request.remoteName,
            refs: { ...request.refs },
            sourceOid: request.sourceOid,
            destination: { ...destination },
            timeoutMs: request.timeoutMs,
          },
          () => {
            if (signal.aborted || destination.targetGeneration !== token())
              throw new PickerProofOwnerError("operationDenied");
            dispatched = true;
          },
        );
        if (result.kind !== "proofGitTrackedPush") throw new PickerProofOwnerError("protocolError");
        if (result.value === "deniedBeforeDispatch") return denied;
        return { status: "finished", receipts: [{ ...receiptIdentity, outcome: result.value }] };
      } catch {
        return dispatched
          ? { status: "finished", receipts: [{ ...receiptIdentity, outcome: "unconfirmed" }] }
          : denied;
      }
    },
  };
}
