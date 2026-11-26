import type { PickerProofAliasList } from "./sshOwnerPickerProof.codec.aliases.ts";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

export interface PickerProofAliasClient {
  /** Read-only discovery over the owner's bound config scope. Never dials. */
  listAliases(): Promise<PickerProofAliasList>;
}

type Execute = (
  operation: PickerProofOperation,
  beforeDispatch?: (id: Uint8Array) => void,
) => Promise<Exclude<Outcome, { kind: "error" }>>;

export function makePickerProofAliasClient(execute: Execute): PickerProofAliasClient {
  return {
    async listAliases() {
      const outcome = await execute({ kind: "listAliases" });
      if (outcome.kind !== "proofAliases") throw new PickerProofOwnerError("protocolError");
      return outcome.value;
    },
  };
}
