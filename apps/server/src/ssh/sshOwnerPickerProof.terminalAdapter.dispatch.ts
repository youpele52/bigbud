import type {
  NativeDirectSshTerminalBinding,
  NativeDirectSshTerminalOpen,
} from "../terminal-host/localTerminalHost.directSsh.owner.port.ts";

const samePane = (a: NativeDirectSshTerminalOpen, b: NativeDirectSshTerminalOpen) =>
  a.targetId === b.targetId &&
  a.pane.threadId === b.pane.threadId &&
  a.pane.terminalId === b.pane.terminalId;

const sameBinding = (a: NativeDirectSshTerminalBinding, b: NativeDirectSshTerminalBinding) =>
  a.targetId === b.targetId &&
  a.ownerEpoch === b.ownerEpoch &&
  a.targetGeneration === b.targetGeneration &&
  a.leaseId === b.leaseId;

type Reservation = {
  readonly input: NativeDirectSshTerminalOpen;
  readonly binding: NativeDirectSshTerminalBinding;
};

/** Serial dispatch inside the proof port; the caller must authorize explicit replacement durably. */
export function makeProofTerminalDispatch(targetId: string, recoverRetained: boolean) {
  let prepared: Reservation | undefined;
  let dispatched: Reservation | undefined;

  const assertCanPrepare = (input: NativeDirectSshTerminalOpen, closedLease?: Uint8Array) => {
    if (
      input.targetId !== targetId ||
      (dispatched &&
        (!samePane(input, dispatched.input) ||
          !closedLease ||
          Buffer.from(closedLease).toString("hex") !== dispatched.binding.leaseId))
    ) {
      throw new Error("Wrong proof target or lease already dispatched.");
    }
  };

  return {
    assertCanPrepare,
    savePreparation(input: NativeDirectSshTerminalOpen, binding: NativeDirectSshTerminalBinding) {
      prepared = { input: { ...input, pane: { ...input.pane } }, binding };
    },
    dispatch(
      input: NativeDirectSshTerminalOpen,
      binding: NativeDirectSshTerminalBinding,
      closedLease?: Uint8Array,
    ) {
      assertCanPrepare(input, closedLease);
      if (
        !prepared ||
        !sameBinding(prepared.binding, binding) ||
        !samePane(prepared.input, input) ||
        prepared.input.cwd !== input.cwd ||
        prepared.input.cols !== input.cols ||
        prepared.input.rows !== input.rows ||
        prepared.input.shell !== input.shell ||
        binding.leaseId === dispatched?.binding.leaseId
      ) {
        throw new Error("Open does not match the prepared proof reservation.");
      }
      // Consume the grant before the only spawn RPC, even if its acknowledgement is lost.
      dispatched = prepared;
      prepared = undefined;
    },
    leaseFor(binding: NativeDirectSshTerminalBinding) {
      // For a cold retained adapter, durable route selection precedes this call. The owner
      // still has to prove this exact lease and its birth generation; decoding is not adoption.
      if (
        recoverRetained &&
        !dispatched &&
        /^[a-f0-9]{64}$/.test(binding.leaseId) &&
        /^[a-f0-9]{64}$/.test(binding.targetGeneration)
      )
        return Buffer.from(binding.leaseId, "hex");
      if (!dispatched || !sameBinding(binding, dispatched.binding))
        throw new Error("The fixture binding does not match the dispatched lease.");
      return Buffer.from(binding.leaseId, "hex");
    },
  };
}
