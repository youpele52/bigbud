import type { NativeDirectSshTerminalBinding } from "../terminal-host/localTerminalHost.directSsh.owner.port.ts";
import type { PickerProofTerminal } from "./sshOwnerPickerProof.codec.terminal.ts";
import type { PickerProofTerminalAdapterClient } from "./sshOwnerPickerProof.terminalAdapter.ts";

export const hexProofToken = (value: Uint8Array) => Buffer.from(value).toString("hex");
const outside = () => new Error("The fixture binding is outside this proof owner.");

export function makeProofTerminalBinding(
  targetId: string,
  recoverRetained: boolean,
  useOwner: <A>(use: (owner: PickerProofTerminalAdapterClient) => Promise<A>) => Promise<A>,
) {
  let lastPid: number | undefined;
  let verifiedOwnerEpoch: string | undefined;
  const signalCheck = (binding: NativeDirectSshTerminalBinding, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (
      binding.targetId !== targetId ||
      (recoverRetained &&
        verifiedOwnerEpoch !== undefined &&
        verifiedOwnerEpoch !== binding.ownerEpoch)
    )
      throw outside();
  };
  return {
    signalCheck,
    useBinding: <A>(
      binding: NativeDirectSshTerminalBinding,
      signal: AbortSignal,
      use: (owner: PickerProofTerminalAdapterClient) => Promise<A>,
    ) =>
      useOwner((owner) => {
        signalCheck(binding, signal);
        if (binding.ownerEpoch !== hexProofToken(owner.ownerEpoch)) throw outside();
        return use(owner);
      }),
    verify(
      binding: NativeDirectSshTerminalBinding,
      lease: Uint8Array,
      receipt: PickerProofTerminal,
    ) {
      if (
        !Buffer.from(receipt.lease).equals(lease) ||
        (recoverRetained &&
          (!receipt.birthGeneration ||
            hexProofToken(receipt.birthGeneration) !== binding.targetGeneration)) ||
        (lastPid !== undefined && lastPid !== receipt.pid)
      )
        throw new Error("The native receipt does not match the proof PTY.");
      lastPid = receipt.pid;
      verifiedOwnerEpoch = binding.ownerEpoch;
      return receipt;
    },
    hasReceipt: () => lastPid !== undefined,
    resetReceipt: () => {
      lastPid = undefined;
    },
  };
}
