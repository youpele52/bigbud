import {
  assertOriginalNativeServiceLeaseClient,
  type ConfirmedNativeCancelFence,
  type ConfirmedNativeLeaseExit,
  type NativeServiceLeaseClient,
  type OriginalNativeLeaseAttempt,
  type OriginalNeverInvoked,
  type PendingOriginalNativeLease,
  type VerifiedNativeLease,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import type { MobileActivationWorker } from "./mobileGatewayActivation.worker.ts";

/** Managed native preparation (`makeNativeMobileGatewayLaunchPreparation`) as a port. */
export interface NativeMobileActivationPreparation<T extends object, I extends object> {
  readonly prepare: (
    assets: T,
    attempt: OriginalNativeLeaseAttempt,
    signal?: AbortSignal,
  ) => Promise<PendingOriginalNativeLease>;
  readonly reserve: (
    pending: PendingOriginalNativeLease,
    signal?: AbortSignal,
  ) => Promise<I | null>;
  readonly markInvoked: (intent: I, signal?: AbortSignal) => Promise<void>;
}
/** Original runtime assets and same-CAS native cleanup; see `.native.assets.ts`. */
export interface NativeMobileActivationAssets<T extends object, C> {
  readonly prepare: (nonce: string, signal: AbortSignal) => Promise<T>;
  readonly writeReceipt: (assets: T, signal: AbortSignal) => Promise<unknown>;
  readonly confirmExit: (
    assets: T,
    client: NativeServiceLeaseClient,
    pending: PendingOriginalNativeLease,
    exit: ConfirmedNativeLeaseExit,
  ) => Promise<C>;
  readonly confirmCancellation: (
    assets: T,
    client: NativeServiceLeaseClient,
    pending: PendingOriginalNativeLease,
    cancellation: ConfirmedNativeCancelFence | OriginalNeverInvoked,
  ) => Promise<C>;
  /** Without cleanup proof only unarmed, never-transferred assets can be removed. */
  readonly remove: (assets: T, cleanup?: C) => Promise<void>;
}
declare const handleBrand: unique symbol;
/** Opaque per-attempt handle; progress lives only in this binding's private map. */
export interface NativeMobileActivationHandle {
  readonly [handleBrand]: true;
}
/** Native evidence that the original Start was fenced or has already exited. */
export type NativeMobileActivationRejection =
  | { readonly kind: "cancelled"; readonly cancellation: ConfirmedNativeCancelFence }
  | { readonly kind: "exited"; readonly exit: ConfirmedNativeLeaseExit };
export type NativeMobileActivationPorts = Pick<
  MobileActivationWorker<
    unknown,
    NativeMobileActivationHandle,
    VerifiedNativeLease,
    ConfirmedNativeLeaseExit,
    NativeMobileActivationRejection,
    unknown
  >,
  "native" | "reserve" | "cancelUnlaunched" | "cancelRejected" | "recordExit"
>;
/** The original client and pending intent behind one lease this binding still holds. */
export interface NativeMobileActivationLease {
  readonly client: NativeServiceLeaseClient;
  readonly pending: PendingOriginalNativeLease;
}
/** Keyed by lease identity: only leases minted by an original client through a binding enter. */
const heldLeases = new WeakMap<VerifiedNativeLease, NativeMobileActivationLease>();
/**
 * Liveness lookup for the worker's `use` phase. Detach and stop retire the entry before their
 * native frame, so a retired, structural or foreign lease is refused rather than reconciled.
 */
export function nativeMobileActivationLease(
  lease: VerifiedNativeLease,
): NativeMobileActivationLease {
  const held = heldLeases.get(lease);
  if (!held) throw Error("Held original native activation lease required.");
  return held;
}
/**
 * Hold a lease that successor Resume #2 verified for exactly this retained original intent, so
 * the owner's native process port can admit it. The returned retire runs before stop/detach.
 */
export function holdNativeMobileSuccessorLease(
  client: NativeServiceLeaseClient,
  pending: PendingOriginalNativeLease,
  lease: VerifiedNativeLease,
): () => void {
  assertOriginalNativeServiceLeaseClient(client);
  if (
    heldLeases.has(lease) ||
    JSON.stringify(client.evidence(lease).binding) !== JSON.stringify(client.binding(pending))
  )
    throw Error("Verified successor lease of the retained original intent required.");
  heldLeases.set(lease, Object.freeze({ client, pending }));
  return () => void heldLeases.delete(lease);
}
interface Progress<T, I> {
  readonly attempt: OriginalNativeLeaseAttempt;
  reserving: boolean;
  assets?: T;
  pending?: PendingOriginalNativeLease;
  intent?: I;
}

/** Thin production binding of the activation worker onto the actual owner client. */
export function nativeMobileActivationPorts<T extends object, I extends object, C>(
  client: NativeServiceLeaseClient,
  preparation: NativeMobileActivationPreparation<T, I>,
  assets: NativeMobileActivationAssets<T, C>,
): NativeMobileActivationPorts {
  assertOriginalNativeServiceLeaseClient(client);
  const attempts = new WeakMap<NativeMobileActivationHandle, Progress<T, I>>();
  const leases = new WeakMap<VerifiedNativeLease, PendingOriginalNativeLease>();
  const exited = new WeakSet<VerifiedNativeLease>();
  const progress = (handle: NativeMobileActivationHandle) => {
    const value = attempts.get(handle);
    if (!value) throw Error("Original native activation handle required.");
    return value;
  };
  const prepared = (handle: NativeMobileActivationHandle) => {
    const value = progress(handle);
    if (!value.assets || !value.pending) throw Error("Original prepared native intent required.");
    return { assets: value.assets, pending: value.pending };
  };
  const held = (lease: VerifiedNativeLease, pending: PendingOriginalNativeLease) => {
    leases.set(lease, pending);
    heldLeases.set(lease, Object.freeze({ client, pending }));
    return lease;
  };
  const owner = (lease: VerifiedNativeLease) => {
    const pending = leases.get(lease);
    if (!pending) throw Error("Original native activation lease required.");
    return pending;
  };
  /** Removal waits for the exact terminal CAS; an uncertain confirmation preserves the assets. */
  const removeConfirmed = async (token: T, confirmed: Promise<C>) =>
    assets.remove(token, await confirmed);
  const native: NativeMobileActivationPorts["native"] = Object.freeze({
    prepareStart: () => {
      const handle = Object.freeze({}) as NativeMobileActivationHandle;
      attempts.set(handle, { attempt: client.beginAttempt(), reserving: false });
      return handle;
    },
    start: async (handle: NativeMobileActivationHandle, signal: AbortSignal) => {
      const { pending } = prepared(handle);
      return held(await client.start(pending, signal), pending);
    },
    reconcile: async (handle: NativeMobileActivationHandle, signal: AbortSignal) => {
      try {
        const { pending } = prepared(handle);
        const status = await client.reconcile(pending, signal);
        if (status.state === "live")
          return { kind: "lease" as const, lease: held(status.lease, pending) };
        const evidence: NativeMobileActivationRejection =
          status.state === "exited"
            ? { kind: "exited", exit: status.exit }
            : { kind: "cancelled", cancellation: status.cancellation };
        return { kind: "notAccepted" as const, evidence: Object.freeze(evidence) };
      } catch {
        return { kind: "uncertain" as const };
      }
    },
    detach: async (lease: VerifiedNativeLease) => {
      owner(lease);
      heldLeases.delete(lease);
      // Confirmed exit already retired the private bootstrap/attachment; its grant is terminal.
      if (exited.has(lease)) return;
      await client.detach(lease);
    },
    stop: async (lease: VerifiedNativeLease) => {
      const pending = owner(lease);
      heldLeases.delete(lease);
      const result = await client.stopOriginal(pending);
      // A cancellation fence for a live lease is never evidence that its original child exited.
      if (result.state !== "exited") throw Error("Original native exit is unconfirmed.");
      exited.add(lease);
      return result.exit;
    },
  });
  return Object.freeze({
    native,
    reserve: async (handle, _selection, signal) => {
      const value = progress(handle);
      if (value.reserving) throw Error("Original native activation is already reserved.");
      value.reserving = true;
      value.assets = await assets.prepare(client.attemptNonce(value.attempt), signal);
      await assets.writeReceipt(value.assets, signal);
      value.pending = await preparation.prepare(value.assets, value.attempt, signal);
      const intent = await preparation.reserve(value.pending, signal);
      // Never Start without a fresh durable same-CAS intent and pin.
      if (!intent) throw Error("Original native intent was not admitted; Start is refused.");
      value.intent = intent;
      await preparation.markInvoked(intent, signal);
    },
    cancelUnlaunched: async (handle, signal) => {
      const value = progress(handle);
      signal.throwIfAborted();
      if (!value.assets) return;
      if (!value.pending) return assets.remove(value.assets);
      const fence = value.intent
        ? await client.cancelPending(value.pending, signal)
        : client.originalNeverInvoked(value.pending);
      await removeConfirmed(
        value.assets,
        assets.confirmCancellation(value.assets, client, value.pending, fence),
      );
    },
    cancelRejected: async (handle, evidence, signal) => {
      signal.throwIfAborted();
      const value = prepared(handle);
      await removeConfirmed(
        value.assets,
        evidence.kind === "exited"
          ? assets.confirmExit(value.assets, client, value.pending, evidence.exit)
          : assets.confirmCancellation(value.assets, client, value.pending, evidence.cancellation),
      );
    },
    recordExit: async (handle, lease, exit, signal) => {
      signal.throwIfAborted();
      const value = prepared(handle);
      if (owner(lease) !== value.pending) throw Error("Original native lease/attempt mismatch.");
      await removeConfirmed(
        value.assets,
        assets.confirmExit(value.assets, client, value.pending, exit),
      );
    },
  });
}
