import { createHash, randomUUID } from "node:crypto";
import {
  currentRemoteAgentController,
  isRemoteAgentControllerAlive,
  type RemoteAgentControllerIdentity,
} from "./remoteAgentController.ts";
import type {
  RemoteAgentInputIdentity,
  RemoteAgentInputResolution,
  RemoteAgentOwner,
  RemoteAgentOwnerStore,
} from "./remoteAgentOwners.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { reconcileRemotePtyInput } from "./remoteAgentPtyClient.reconcile.ts";
import type { RemoteAgentPtyInputState } from "./remoteAgentPtyClient.types.ts";

class InputClaimChanged extends Error {}

interface ClaimEnvironment {
  controller: RemoteAgentControllerIdentity;
  alive: typeof isRemoteAgentControllerAlive;
  nonce: () => string;
}

export function remoteAgentInputIdentity(
  sequence: number,
  bytes: Uint8Array,
): RemoteAgentInputIdentity {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  return {
    sequence,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256")
      .update("bigbud/pty-input/receipt-v1\0")
      .update(length)
      .update(bytes)
      .digest("hex"),
  };
}

function sameInput(
  left: RemoteAgentInputIdentity | undefined,
  right: RemoteAgentInputIdentity,
): boolean {
  return (
    left?.sequence === right.sequence &&
    left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength
  );
}

function sameAuthority(
  left: RemoteAgentOwner["inputAuthority"],
  right: RemoteAgentOwner["inputAuthority"],
): boolean {
  return (
    left?.id === right?.id &&
    left?.pid === right?.pid &&
    left?.startedAt === right?.startedAt &&
    left?.nonce === right?.nonce
  );
}

function assertResource(current: RemoteAgentOwner, expected: RemoteAgentOwner): void {
  if (
    current.ownerKey !== expected.ownerKey ||
    current.resourceId !== expected.resourceId ||
    current.target !== expected.target ||
    current.epoch !== expected.epoch ||
    current.digest !== expected.digest ||
    current.connectionId !== expected.connectionId ||
    JSON.stringify(current.runtime) !== JSON.stringify(expected.runtime) ||
    current.state === "terminal"
  )
    throw new Error("Remote input resource authority changed.");
}

/** Revision-CAS input authority, independent of immutable original launch ownership. */
export class RemoteAgentOwnedInput {
  private constructor(
    private readonly store: RemoteAgentOwnerStore,
    private owner: RemoteAgentOwner,
    private readonly authority: NonNullable<RemoteAgentOwner["inputAuthority"]>,
  ) {}

  static async claim(
    store: RemoteAgentOwnerStore,
    expected: RemoteAgentOwner,
    environment: ClaimEnvironment = {
      controller: currentRemoteAgentController(),
      alive: isRemoteAgentControllerAlive,
      nonce: randomUUID,
    },
  ): Promise<RemoteAgentOwnedInput> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const observed = await store.get(expected.ownerKey);
      if (!observed) throw new Error("Remote input owner is missing.");
      assertResource(observed, expected);
      const previous =
        observed.inputAuthority ??
        (observed.controllerId &&
        observed.controllerPid !== undefined &&
        observed.controllerStartedAt
          ? {
              id: observed.controllerId,
              pid: observed.controllerPid,
              startedAt: observed.controllerStartedAt,
            }
          : undefined);
      if (
        !previous ||
        (previous.id !== environment.controller.id && (await environment.alive(previous)))
      )
        throw new Error("Previous remote input controller is live or unconfirmed.");
      const authority = { ...environment.controller, nonce: environment.nonce() };
      try {
        const owner = await store.update(expected.ownerKey, (current) => {
          assertResource(current, expected);
          if (
            !sameAuthority(current.inputAuthority, observed.inputAuthority) ||
            current.controllerId !== observed.controllerId ||
            current.controllerPid !== observed.controllerPid ||
            current.controllerStartedAt !== observed.controllerStartedAt
          )
            throw new InputClaimChanged("Input claim changed; re-evaluate controller evidence.");
          return {
            ...current,
            inputAuthority: authority,
            ...(current.inputResolved === undefined &&
            current.nextInputSequence === current.inputAcknowledged + 1
              ? { inputResolved: current.inputAcknowledged }
              : {}),
          };
        });
        return new RemoteAgentOwnedInput(store, owner, authority);
      } catch (cause) {
        if (!(cause instanceof InputClaimChanged)) throw cause;
      }
    }
    throw new Error("Remote input authority contention exceeded its bounded retry budget.");
  }

  snapshot(): RemoteAgentOwner {
    return this.owner;
  }

  async reconcile(
    connection: RemoteAgentConnection,
    signal: AbortSignal,
  ): Promise<RemoteAgentPtyInputState> {
    await this.update((current) => current); // Validate current authority before any native mutation.
    if (this.owner.pendingInput) {
      const resolution = await reconcileRemotePtyInput(connection, this.owner, signal);
      await this.settle(resolution);
    }
    const resolvedSequence = this.owner.inputResolved ?? this.owner.inputAcknowledged;
    if (this.owner.nextInputSequence !== resolvedSequence + 1)
      throw new Error("Legacy input is unconfirmed and has no receipt identity.");
    return {
      nextSequence: this.owner.nextInputSequence,
      resolvedSequence,
      writerUsable: this.owner.inputResolution?.writerUsable !== false,
    };
  }

  async allocated(sequence: number, bytes: Uint8Array): Promise<void> {
    const identity = remoteAgentInputIdentity(sequence, bytes);
    await this.update((current) => {
      if (
        current.pendingInput ||
        current.inputResolved === undefined ||
        sequence !== current.nextInputSequence ||
        sequence !== current.inputResolved + 1 ||
        current.inputResolution?.writerUsable === false
      )
        throw new Error("Remote input allocation is stale, unresolved or unavailable.");
      return { ...current, nextInputSequence: sequence + 1, pendingInput: identity };
    });
  }

  async acknowledged(sequence: number): Promise<void> {
    const pending = this.owner.pendingInput ?? this.owner.inputResolution;
    if (!pending || pending.sequence !== sequence)
      throw new Error("Remote input acknowledgement does not match the pending identity.");
    await this.settle({ ...pending, outcome: "written", writerUsable: true });
  }

  async settle(receipt: RemoteAgentInputResolution): Promise<void> {
    await this.update((current) => {
      if (
        sameInput(current.inputResolution, receipt) &&
        current.inputResolution?.outcome === receipt.outcome &&
        current.inputResolution.writerUsable === receipt.writerUsable
      )
        return current; // Exact committed receipt; preserve any newer pending allocation.
      if (
        !sameInput(current.pendingInput, receipt) ||
        current.inputResolved === undefined ||
        current.inputResolved + 1 !== receipt.sequence ||
        current.nextInputSequence !== receipt.sequence + 1
      )
        throw new Error("Remote input settlement is stale or conflicts with durable input.");
      const { pendingInput: _pending, ...rest } = current;
      return {
        ...rest,
        inputResolved: receipt.sequence,
        inputResolution: receipt,
        inputAcknowledged:
          receipt.outcome === "written" ? receipt.sequence : current.inputAcknowledged,
      };
    });
  }

  private async update(transition: (current: RemoteAgentOwner) => RemoteAgentOwner): Promise<void> {
    this.owner = await this.store.update(this.owner.ownerKey, (current) => {
      assertResource(current, this.owner);
      if (!sameAuthority(current.inputAuthority, this.authority))
        throw new Error("Remote input observer authority is stale.");
      return transition(current);
    });
  }
}

/** Observe each cold-attach stage without cancelling a shared pool operation or rolling
 * back a late durable CAS. The caller must check expiry before creating an observer. */
export class RemoteAgentColdAttach {
  readonly signal: AbortSignal;

  constructor(parentSignal?: AbortSignal) {
    const deadline = AbortSignal.timeout(15_000);
    this.signal = parentSignal ? AbortSignal.any([deadline, parentSignal]) : deadline;
  }

  async observe<T>(operation: Promise<T>): Promise<T> {
    // Attach handlers even if already expired, so a late rejection is still observed.
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", abort, { once: true });
      operation.then(
        (value) => {
          this.signal.removeEventListener("abort", abort);
          if (this.signal.aborted) abort();
          else resolve(value);
        },
        (cause) => {
          this.signal.removeEventListener("abort", abort);
          reject(cause);
        },
      );
      if (this.signal.aborted) abort();
    });
  }
}
