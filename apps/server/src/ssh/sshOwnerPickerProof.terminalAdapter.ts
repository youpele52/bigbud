import type {
  NativeDirectSshTerminalBinding,
  NativeDirectSshTerminalOwner,
} from "../terminal-host/localTerminalHost.directSsh.owner.port.ts";
import {
  NativeSshPtyHostLostError,
  type PtyExitEvent,
  type PtyProcess,
} from "../terminal/Services/PTY.ts";
import type { PickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import type { PickerProofTerminal } from "./sshOwnerPickerProof.codec.terminal.ts";
import { makeProofTerminalDispatch } from "./sshOwnerPickerProof.terminalAdapter.dispatch.ts";
import { makeProofTerminalQueue } from "./sshOwnerPickerProof.terminalAdapter.queue.ts";
import {
  makeProofTerminalOutput,
  verifyProofTerminalReplay,
} from "./sshOwnerPickerProof.terminalAdapter.replay.ts";

import {
  hexProofToken as hex,
  makeProofTerminalBinding,
} from "./sshOwnerPickerProof.terminalAdapter.binding.ts";
export type PickerProofTerminalAdapterClient = Pick<
  PickerProofOwner,
  | "ownerEpoch"
  | "prepareProofTerminal"
  | "cancelProofTerminalReservation"
  | "openReservedProofTerminal"
  | "proofTerminalStatus"
  | "closeProofTerminal"
  | "writeProofTerminalInput"
  | "resizeProofTerminal"
  | "replayProofTerminal"
>;

type ReplayCut = ReturnType<typeof verifyProofTerminalReplay> & { readonly final?: boolean };
type InteractiveClient = {
  readonly withOwner: <A>(
    use: (owner: PickerProofTerminalAdapterClient) => Promise<A>,
  ) => Promise<A>;
};
type Observer = PtyProcess & { detach(): void; finish(): void };

const INPUT_CHUNK_BYTES = 4096;
const MAX_INPUT_BYTES = 256 * 1024;
const STATUS_INTERVAL_MS = 250;

/** The exact output cut is byte replay, not a renderer snapshot. */
export function makePickerProofTerminalAdapter(
  client: PickerProofTerminalAdapterClient | InteractiveClient,
  targetId: string,
  recoverRetained = false,
) {
  const interactive = "withOwner" in client;
  const useOwner = <A>(use: (owner: PickerProofTerminalAdapterClient) => Promise<A>) =>
    interactive ? client.withOwner(use) : use(client);
  const dispatch = makeProofTerminalDispatch(targetId, recoverRetained);
  let closed: PickerProofTerminal | undefined;
  let exited: PickerProofTerminal | undefined;
  let observer: Observer | undefined;
  let nextInput: number | undefined = 1;
  let inputFailure: Error | undefined;
  const { control, poll } = makeProofTerminalQueue(interactive);

  const { signalCheck, useBinding, verify, hasReceipt, resetReceipt } = makeProofTerminalBinding(
    targetId,
    recoverRetained,
    useOwner,
  );
  const leaseFor = (binding: NativeDirectSshTerminalBinding, signal: AbortSignal) => {
    signalCheck(binding, signal);
    return dispatch.leaseFor(binding);
  };
  const sample = async (binding: NativeDirectSshTerminalBinding, signal: AbortSignal) => {
    const lease = leaseFor(binding, signal);
    return control(async () => {
      const receipt =
        closed ??
        exited ??
        (await useBinding(binding, signal, (owner) => owner.proofTerminalStatus(lease)));
      signal.throwIfAborted();
      return verify(binding, lease, receipt);
    });
  };
  const closeTerminal = async (binding: NativeDirectSshTerminalBinding, signal: AbortSignal) => {
    const lease = leaseFor(binding, signal);
    // Neither a transport error nor a missing lease is proof of reaping. Cache only the
    // exact native acknowledgement, including if the caller was cancelled while awaiting it.
    const receipt = verify(
      binding,
      lease,
      closed ??
        (await useBinding(binding, signal, async (owner) => {
          if (recoverRetained) verify(binding, lease, await owner.proofTerminalStatus(lease));
          signal.throwIfAborted();
          return owner.closeProofTerminal(lease);
        })),
    );
    if (receipt.live) throw new Error("The proof owner did not confirm local PTY exit.");
    closed = receipt;
    try {
      signal.throwIfAborted();
    } finally {
      if (interactive) observer?.finish();
      else observer?.detach();
    }
    return { binding, state: "exited" as const };
  };

  const replay = async (
    owner: PickerProofTerminalAdapterClient,
    lease: Uint8Array,
    afterSequence: number,
  ) =>
    verifyProofTerminalReplay(
      lease,
      afterSequence,
      await owner.replayProofTerminal(lease, afterSequence),
    );
  async function attach(
    receipt: PickerProofTerminal,
    lease: Uint8Array,
    binding: NativeDirectSshTerminalBinding,
    signal: AbortSignal,
    recovered = false,
  ) {
    signal.throwIfAborted();
    if (!receipt.live && !interactive) throw new Error("The proof PTY is not live.");
    // A cold observer needs the complete byte prefix from zero, not an arbitrary retained tail.
    const cut = await useBinding(binding, signal, (owner) => replay(owner, lease, 0));
    signal.throwIfAborted();
    if (recoverRetained) nextInput = receipt.nextInputSequence;
    if (!receipt.live) exited = receipt;
    observer = makeProofObserver(receipt.pid, lease, binding, { ...cut, final: !receipt.live });
    return {
      binding,
      process: observer,
      ...(recovered ? { recoveredHistoryFromStart: true as const } : {}),
    };
  }

  const port: NativeDirectSshTerminalOwner = {
    prepareOpen: (input, signal) =>
      control(async () => {
        signal.throwIfAborted();
        dispatch.assertCanPrepare(input, closed?.lease);
        const reservation = await useOwner(async (owner) => {
          signal.throwIfAborted();
          const reserved = await owner.prepareProofTerminal({
            ...input.pane,
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            ...(input.shell === undefined ? {} : { shell: input.shell }),
          });
          if (signal.aborted) {
            await owner.cancelProofTerminalReservation(reserved.lease);
            signal.throwIfAborted();
          }
          return reserved;
        });
        const binding = Object.freeze({
          targetId,
          ownerEpoch: hex(reservation.ownerEpoch),
          targetGeneration: hex(reservation.targetGeneration),
          leaseId: hex(reservation.lease),
        });
        dispatch.savePreparation(input, binding);
        return binding;
      }),
    open: (input, binding, signal) =>
      control(async () => {
        signalCheck(binding, signal);
        dispatch.dispatch(input, binding, closed?.lease);
        // Keep the previous close receipt until the next grant is committed for dispatch.
        // Retire its observer before resetting any lease-local IO state.
        observer?.detach();
        resetReceipt();
        closed = undefined;
        exited = undefined;
        nextInput = 1;
        inputFailure = undefined;
        const lease = leaseFor(binding, signal);
        const receipt = verify(
          binding,
          lease,
          await useBinding(binding, signal, (owner) => owner.openReservedProofTerminal(lease)),
        );
        return attach(receipt, lease, binding, signal);
      }),
    reattach: (binding, signal) =>
      control(async () => {
        const lease = leaseFor(binding, signal);
        if (observer || closed || (!recoverRetained && !hasReceipt()))
          throw new Error("The proof PTY does not have a confirmed detached lease.");
        return attach(
          verify(
            binding,
            lease,
            await useBinding(binding, signal, (owner) => owner.proofTerminalStatus(lease)),
          ),
          lease,
          binding,
          signal,
          recoverRetained,
        );
      }),
    async status(binding, signal) {
      return { binding, state: (await sample(binding, signal)).live ? "live" : "exited" };
    },
    close: (binding, signal) => control(() => closeTerminal(binding, signal)),
  };

  function makeProofObserver(
    pid: number,
    lease: Uint8Array,
    binding: NativeDirectSshTerminalBinding,
    cut: ReplayCut,
  ): Observer {
    const lifetime = new AbortController();
    const errors = new Set<(error: Error) => void>();
    const exits = new Set<(event: PtyExitEvent) => void>();
    // Existing manager translates a non-integer exit code to null. The wire proves reap only.
    const event = { exitCode: Number.NaN, signal: null };
    let finished = false;
    let closeQueued = false;
    let pendingBytes = 0;
    let nextStatusAt = Date.now() + STATUS_INTERVAL_MS;
    let failure: Error | undefined;
    const fail = (cause: unknown) => {
      if (lifetime.signal.aborted || failure) return;
      failure = cause instanceof Error ? cause : new Error("Proof terminal operation failed.");
      output.stop();
      for (const notify of errors) notify(failure);
    };
    const output = makeProofTerminalOutput(
      cut,
      (afterSequence) =>
        closed || exited
          ? undefined
          : poll(() =>
              useBinding(binding, lifetime.signal, async (owner) => {
                const status =
                  interactive && Date.now() >= nextStatusAt
                    ? verify(binding, lease, await owner.proofTerminalStatus(lease))
                    : undefined;
                if (status) nextStatusAt = Date.now() + STATUS_INTERVAL_MS;
                lifetime.signal.throwIfAborted();
                const received = await replay(owner, lease, afterSequence);
                if (status && !status.live) {
                  exited = status;
                  return { ...received, final: true };
                }
                return received;
              }),
            ),
      fail,
      () => process.finish(),
    );
    const act = (operation: () => Promise<unknown>, closing = false, bytes = 0) => {
      if (lifetime.signal.aborted || finished || (failure && !closing)) return;
      if (bytes + pendingBytes > MAX_INPUT_BYTES)
        return fail(new Error("Terminal input queue is full."));
      pendingBytes += bytes;
      void control(async () => {
        lifetime.signal.throwIfAborted();
        if ((!failure && !exited && !closed) || closing) await operation();
      }, closing)
        .catch(fail)
        .finally(() => {
          pendingBytes -= bytes;
        });
    };
    const process: Observer = {
      pid,
      detach() {
        lifetime.abort();
        output.stop();
        errors.clear();
        exits.clear();
        if (observer === process) observer = undefined;
      },
      finish() {
        if (finished || lifetime.signal.aborted) return;
        finished = true;
        output.stop();
        errors.clear();
        for (const notify of exits) notify(event);
        exits.clear();
      },
      write(data) {
        if (!data) return;
        const bytes = Buffer.byteLength(data);
        act(
          async () => {
            if (inputFailure) throw inputFailure;
            try {
              const payload = Buffer.from(data);
              const stride = interactive ? INPUT_CHUNK_BYTES : payload.length;
              for (let offset = 0; offset < payload.length; offset += stride) {
                const sequence = nextInput;
                if (sequence === undefined)
                  throw new Error("The previous writer left an uncertain input outcome.");
                const receipt = verify(
                  binding,
                  lease,
                  await useBinding(binding, lifetime.signal, (owner) =>
                    owner.writeProofTerminalInput(
                      lease,
                      sequence,
                      payload.subarray(offset, offset + stride),
                    ),
                  ),
                );
                if (!receipt.live && !interactive) throw new Error("The proof PTY is not live.");
                nextInput = recoverRetained ? receipt.nextInputSequence : sequence + 1;
                if (!receipt.live) break; // The next poll drains the verified exit's output.
              }
            } catch (cause) {
              // A lost acknowledgement may already have applied the write. Never replay it
              // or reuse its sequence from a subsequent observer.
              inputFailure =
                cause instanceof NativeSshPtyHostLostError
                  ? cause
                  : new Error("The proof terminal input could not be confirmed.", { cause });
              throw inputFailure;
            }
          },
          false,
          bytes,
        );
      },
      resize(cols, rows) {
        act(async () => {
          const receipt = verify(
            binding,
            lease,
            await useBinding(binding, lifetime.signal, (owner) =>
              owner.resizeProofTerminal(lease, cols, rows),
            ),
          );
          if (!receipt.live && !interactive) throw new Error("The proof PTY is not live.");
        });
      },
      kill(signal) {
        if (signal !== undefined && signal !== "SIGTERM")
          return fail(new Error("The proof terminal supports managed close only."));
        if (closeQueued) return;
        closeQueued = true;
        act(async () => {
          try {
            await closeTerminal(binding, lifetime.signal);
          } finally {
            closeQueued = false;
          }
        }, true);
      },
      onError(callback) {
        if (!lifetime.signal.aborted) {
          if (failure) callback(failure);
          else errors.add(callback);
        }
        return () => errors.delete(callback);
      },
      onData: output.onData,
      onSequencedData: output.onSequencedData,
      onExit(callback) {
        if (!interactive || lifetime.signal.aborted) return () => {};
        if (finished) {
          callback(event);
          return () => {};
        }
        exits.add(callback);
        const stopWatching = output.onData(() => {});
        return () => {
          exits.delete(callback);
          stopWatching();
        };
      },
    };
    return process;
  }

  return { port, sample };
}
