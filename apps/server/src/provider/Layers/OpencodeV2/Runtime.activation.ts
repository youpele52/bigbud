import * as Effect from "effect/Effect";
import { isDeepStrictEqual } from "node:util";
import type { V2IsolatedRuntimeOptions, V2RuntimeSession } from "./Runtime.types.ts";
import type { OpencodeV2Client } from "./Client.ts";
import { v2Request } from "./Client.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeMutations } from "./Runtime.mutations.ts";
import { currentV2CallerSignal, assertV2CallerCurrent } from "./Runtime.caller.ts";
import { captureV2OperationAuthority } from "./Client.guard.ts";
import { refreshV2FamilyDrain } from "./Runtime.family.drain.ts";
import {
  runInV2Settlement,
  v2SettlementBusyReason,
  type V2SettlementHoldReason,
} from "./Runtime.activation.hold.ts";

export class V2PreAdmissionRetry extends Error {
  constructor() {
    super("V2 activation readiness changed before admission; retry only outside queues.");
  }
}
export async function awaitV2RuntimeReady(
  options: V2IsolatedRuntimeOptions,
  client: OpencodeV2Client,
  directory: string,
  signal: AbortSignal | undefined,
  hidden: boolean,
  identity?: import("./Orchestration.selection.ts").V2SessionRegistrationIdentity,
) {
  assertV2CallerCurrent();
  const caller = currentV2CallerSignal();
  if (caller) signal = AbortSignal.any([caller, ...(signal ? [signal] : [])]);
  if (options.activation)
    return options.activation.awaitReady(client, directory, signal, hidden, identity);
  if (!hidden) await options.threadToolsPreflight?.(client, directory, signal);
  assertV2CallerCurrent();
  return undefined;
}

/** A pre-enrollment resource failure may release only a fully verified, physically drained creation. */
export async function settleV2PreparedReservation(
  options: V2IsolatedRuntimeOptions,
  created: Pick<
    V2RuntimeSession,
    "activation" | "native" | "threadId" | "storageIdentity" | "lease"
  >,
  mutations: V2RuntimeMutations,
) {
  const activation = created.activation,
    token = activation?.token;
  if (!activation || !token) return;
  if (activation.gate.cancelUndispatched(token)) {
    activation.token = undefined;
    activation.phase = "settled";
    return;
  }
  try {
    if (mutations.busyCount()) return;
    const rows = await Effect.runPromise(
      options.journal.listBoundPage({ threadId: created.threadId, limit: 2, unresolvedOnly: true }),
    );
    if (rows.length) return;
    const binding = options.sharedBindings
      ? await Effect.runPromise(options.sharedBindings.find(created.threadId))
      : undefined;
    if (
      options.config.sharedService &&
      (!binding ||
        binding.state !== "verified" ||
        binding.nativeSessionId !== created.native.id ||
        binding.storageIdentity !== created.storageIdentity ||
        binding.directory !== created.native.location.directory)
    )
      return;
    const active = await v2Request(
      "failed-start exact-session drain",
      (signal) => created.lease.process.client.session.active({ signal }),
      { timeoutMs: 5000 },
    );
    if (active[created.native.id] || mutations.busyCount()) return;
    activation.gate.settle(token, {
      physical: true,
      durable: true,
      nativeDrained: true,
      callbacksSettled: true,
    });
    activation.token = undefined;
    activation.phase = "settled";
  } catch {
    activation.phase = "uncertain";
  } // Revoked/unreadable evidence stays owned; never infer idle.
}

/** Terminal delivery plus authoritative native drain/durable journal proof discharge a held physical token.
 * Returns the hold reason when the reservation stays owned; `undefined` when settled or nothing is held. */
export function settleV2RuntimeReservation(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
): Promise<V2SettlementHoldReason | undefined> {
  return runInV2Settlement(() => settleV2RuntimeReservationOnce(runtime, owner));
}

async function settleV2RuntimeReservationOnce(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
): Promise<V2SettlementHoldReason | undefined> {
  const activation = owner.activation,
    token = activation?.token;
  if (!activation || !token) {
    owner.backgroundClosure?.assertCurrent();
    delete owner.backgroundClosure;
    return undefined;
  }
  const authority = captureV2OperationAuthority();
  const epoch = owner.epoch,
    dirty = owner.dirtyGeneration,
    generation = owner.lease.hub.generation(owner.native.id),
    row = owner.row;
  const validate = () => {
    authority.assertCurrent();
    owner.consentPermit?.assertCurrent();
    if (owner.backgroundClosure) {
      if (owner.backgroundClosure.turnId !== owner.row?.turnId)
        throw new Error("V2 background settlement turn changed; reservation retained.");
      owner.backgroundClosure.assertCurrent();
    }
    if (
      owner.stopped ||
      runtime.sessions.get(owner.threadId) !== owner ||
      owner.epoch !== epoch ||
      owner.dirtyGeneration !== dirty ||
      owner.lease.hub.generation(owner.native.id) !== generation ||
      !owner.lease.process.isRunning() ||
      owner.activation !== activation ||
      activation.token !== token ||
      owner.row !== row
    )
      throw new Error("V2 settlement owner/generation changed; reservation retained.");
  };
  validate();
  // H1: release only proven-settled failed callbacks before observing busy state.
  if (owner.coding?.reconcile) {
    await owner.coding.reconcile();
    validate();
  }
  const busy = () => v2SettlementBusyReason(runtime, owner);
  await refreshV2FamilyDrain(owner, validate);
  const held = busy();
  if (held) return held;
  const reserved = row?.state === "reserved";
  if (row && !reserved && (row.state !== "terminal" || !owner.terminalDelivered))
    return "row-not-terminal";
  const unresolved = await Effect.runPromise(
    runtime.options.journal.listBoundPage({
      threadId: owner.threadId,
      limit: 2,
      unresolvedOnly: true,
    }),
  );
  validate();
  // A reservation proves no prompt dispatch intent exists. Keep it intact for exact retry;
  // discharge only its physical setup token, never an unknown or different admission.
  if (
    reserved ? unresolved.length !== 1 || !isDeepStrictEqual(unresolved[0], row) : unresolved.length
  )
    return "unresolved-journal";
  const binding = runtime.options.sharedBindings
    ? await Effect.runPromise(runtime.options.sharedBindings.find(owner.threadId))
    : undefined;
  validate();
  if (
    runtime.options.config.sharedService &&
    (!binding ||
      binding.state !== "verified" ||
      binding.nativeSessionId !== owner.native.id ||
      binding.storageIdentity !== owner.storageIdentity ||
      binding.directory !== owner.native.location.directory)
  )
    return "binding";
  const active = await v2Request(
    "activation exact-session drain",
    (signal) => owner.lease.process.client.session.active({ signal }),
    { timeoutMs: 5000 },
  );
  validate();
  if (active[owner.native.id]) return "native-active";
  if (reserved || owner.familyControl?.nativeReceipt) {
    const inbox = await v2Request("family activation input drain", (signal) =>
      owner.lease.process.client.session.inbox.list({ sessionID: owner.native.id }, { signal }),
    );
    validate();
    if (inbox.length) return "native-active";
  }
  await refreshV2FamilyDrain(owner, validate);
  if (reserved) {
    const latest = await Effect.runPromise(
      runtime.options.journal.listBoundPage({
        threadId: owner.threadId,
        limit: 2,
        unresolvedOnly: true,
      }),
    );
    validate();
    if (latest.length !== 1 || !isDeepStrictEqual(latest[0], row)) return "unresolved-journal";
  }
  if (owner.activation !== activation || activation.token !== token) return "callbacks";
  const late = busy();
  if (late) return late;
  activation.gate.settle(token, {
    physical: true,
    durable: true,
    nativeDrained: true,
    callbacksSettled: true,
  });
  activation.token = undefined;
  activation.phase = "settled";
  delete owner.backgroundClosure;
  return undefined;
}
