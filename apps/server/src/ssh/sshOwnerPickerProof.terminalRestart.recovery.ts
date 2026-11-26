import type {
  NativeDirectSshTerminalBinding,
  NativeDirectSshTerminalOwner,
} from "../terminal-host/localTerminalHost.directSsh.owner.port.ts";
import type { PickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  makeProofTerminalOutput,
  verifyProofTerminalReplay,
} from "./sshOwnerPickerProof.terminalAdapter.replay.ts";

const forbidden = (): never => {
  throw new Error("The cold proof dispatcher cannot spawn, resize, send input, or kill a PTY.");
};

type TerminalRecoveryClient = Pick<
  PickerProofOwner,
  "ownerEpoch" | "proofTerminalStatus" | "replayProofTerminal" | "closeProofTerminal"
>;

/** Recovery cannot spawn or write input; explicit lifecycle close is for fixture cleanup. */
export function makeTerminalRestartRecovery(
  owner: TerminalRecoveryClient,
  targetId: string,
  capture: (cut: Awaited<ReturnType<PickerProofOwner["replayProofTerminal"]>>) => void,
): NativeDirectSshTerminalOwner {
  const status = async (binding: NativeDirectSshTerminalBinding, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (
      binding.targetId !== targetId ||
      binding.ownerEpoch !== Buffer.from(owner.ownerEpoch).toString("hex") ||
      !/^[0-9a-f]{64}$/.test(binding.targetGeneration) ||
      !/^[0-9a-f]{64}$/.test(binding.leaseId)
    )
      throw new Error("The persisted binding does not identify this proof owner.");
    // The authenticated owner authorizes this exact lease within the current target generation.
    const lease = Buffer.from(binding.leaseId, "hex");
    const receipt = await owner.proofTerminalStatus(lease);
    signal.throwIfAborted();
    if (!Buffer.from(receipt.lease).equals(lease)) throw new Error("Unexpected proof lease.");
    return { lease, receipt };
  };
  return {
    prepareOpen: forbidden,
    open: forbidden,
    async status(binding, signal) {
      const { receipt } = await status(binding, signal);
      return { binding, state: receipt.live ? "live" : "exited" };
    },
    async close(binding, signal) {
      const { lease, receipt } = await status(binding, signal);
      const closed = await owner.closeProofTerminal(lease);
      signal.throwIfAborted();
      if (closed.live || closed.pid !== receipt.pid || !Buffer.from(closed.lease).equals(lease))
        throw new Error("The owner did not confirm the original proof PTY exited.");
      return { binding, state: "exited" };
    },
    async reattach(binding, signal) {
      const { lease, receipt } = await status(binding, signal);
      if (!receipt.live) throw new Error("The retained proof PTY is not live.");
      const cut = verifyProofTerminalReplay(lease, 0, await owner.replayProofTerminal(lease, 0));
      signal.throwIfAborted();
      capture(cut);
      // This fixture asserts the exact cold cut only, not ongoing input or live polling.
      const output = makeProofTerminalOutput(
        cut,
        () => undefined,
        (cause) => {
          throw cause;
        },
      );
      return {
        binding,
        process: {
          pid: receipt.pid,
          detach: output.stop,
          onData: output.onData,
          onSequencedData: output.onSequencedData,
          onExit: () => () => {},
          write: forbidden,
          resize: forbidden,
          kill: forbidden,
        },
      };
    },
  };
}
