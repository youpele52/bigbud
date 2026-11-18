import * as fs from "node:fs/promises";
import type { MobileGatewayAttempt } from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { completeNativeMobileGatewayAttempt } from "../remote-agent/mobileGatewayLifecycle.native.transitions.ts";
import { mobileGatewayBuildPin } from "../remote-agent/mobileGatewayLifecycle.transitions.ts";
import type { MobileRegistryOwner } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { localSupervisorTarget } from "./localSupervisorIdentity.ts";
import type { MobileRuntimeRepairReport } from "./mobileGatewayAssets.orphan.ts";

export const MOBILE_NATIVE_RESOLVE_REASONS = [
  "prior-boot",
  "settled-supervisor-exit",
  "live-epoch",
  "death-unproven",
  "journal-inconsistent",
] as const;
export type MobileNativeResolveReason = (typeof MOBILE_NATIVE_RESOLVE_REASONS)[number];
export interface MobileNativeResolveEntry {
  readonly generation: string;
  readonly outcome: "cleared" | "kept";
  readonly reason: MobileNativeResolveReason;
}
export interface MobileNativeResolveReport {
  readonly cleared: number;
  readonly kept: number;
  /** Gateway attempts of any kind still unsettled after this run. */
  readonly unresolved: number;
  readonly entries: ReadonlyArray<MobileNativeResolveEntry>;
  /** The orphan runtime-asset GC run after the journal settled; `null` if it did not run. */
  readonly repair: MobileRuntimeRepairReport | null;
}
/** Native host facts read now: the canonical current agent epoch and the kernel boot id. */
export interface MobileNativeHostEvidence {
  readonly epoch: string | null;
  readonly bootId: string;
}
type AttemptedNative = MobileGatewayAttempt & {
  readonly nativeOwnership: NonNullable<MobileGatewayAttempt["nativeOwnership"]>;
};
export type NativeEpochEndedProof =
  | { readonly kind: "proven"; readonly proof: "prior-boot" | "settled-supervisor-exit" }
  | { readonly kind: "kept"; readonly reason: MobileNativeResolveReason };

const BOOT = /^start-v2:linux:([^:]{1,64}):[0-9]{1,32}$/;
/** Restart phases the canonical core writes only after it verified the old supervisor dead. */
const DEATH_PROVEN = new Set(["starting", "ready"]);

export const attemptedNativeMobileRows = (state: RemoteAgentRegistry) =>
  state.schemaVersion !== 3
    ? []
    : (state.mobile.gatewayLifecycle?.attempts ?? []).filter(
        (a): a is AttemptedNative => a.phase === "attempted" && a.nativeOwnership !== undefined,
      );

/**
 * Evidence-only proof that the native supervisor epoch owning this attempt's original lease has
 * ended together with its owned work, so the original gateway is dead:
 * - prior boot: the original controller (and so its gateway) started in an earlier kernel boot;
 * - settled supervisor exit: the canonical P4 restart of exactly that epoch reached `starting`,
 *   which it writes only after the old supervisor's exit receipt (written by the native drain only
 *   once every owned lease settled) or a prior-boot proof.
 * A live epoch, a missing pin or anything else is never cleared: that would be a guess.
 */
export function nativeMobileEpochEndedProof(
  state: RemoteAgentRegistry,
  attempt: AttemptedNative,
  host: MobileNativeHostEvidence,
): NativeEpochEndedProof {
  const epoch = attempt.nativeOwnership.binding.nativeEpoch;
  if (
    state.pins.find((p) => p.owner === mobileGatewayBuildPin(attempt.nonce))?.buildId !==
      attempt.binding.buildId ||
    attempt.binding.epoch !== epoch
  )
    return { kind: "kept", reason: "journal-inconsistent" };
  if (host.epoch === epoch) return { kind: "kept", reason: "live-epoch" };
  const boot = BOOT.exec(attempt.controller.startedAt)?.[1];
  if (!boot) return { kind: "kept", reason: "journal-inconsistent" };
  if (boot !== host.bootId) return { kind: "proven", proof: "prior-boot" };
  if (state.restartReservations.some((r) => r.expectedEpoch === epoch && DEATH_PROVEN.has(r.phase)))
    return { kind: "proven", proof: "settled-supervisor-exit" };
  return { kind: "kept", reason: "death-unproven" };
}

/** CAS transition: re-proves on the exact state being written, then records the terminal row. */
export function settleEndedNativeMobileAttempt(
  state: RemoteAgentRegistry,
  pin: MobileRegistryOwner,
  nonce: string,
  host: MobileNativeHostEvidence,
  now: number,
): RemoteAgentRegistry {
  const attempt = attemptedNativeMobileRows(state).find((a) => a.nonce === nonce);
  if (!attempt) throw Error("Attempted native row changed before its settlement.");
  const proof = nativeMobileEpochEndedProof(state, attempt, host);
  if (proof.kind !== "proven") throw Error(`Native epoch end is not proven: ${proof.reason}.`);
  return completeNativeMobileGatewayAttempt(
    state,
    pin,
    attempt.nativeOwnership,
    {
      kind: "native-epoch-ended",
      epoch: attempt.nativeOwnership.binding.nativeEpoch,
      proof: proof.proof,
    },
    now,
  );
}

export async function readNativeMobileHostEvidence(
  owners: Pick<RemoteAgentOwnerStore, "getBinding">,
  pin: MobileRegistryOwner,
): Promise<MobileNativeHostEvidence> {
  const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!/^[a-f0-9-]{36}$/.test(bootId)) throw Error("Kernel boot identity is unavailable.");
  const binding = await owners.getBinding(localSupervisorTarget(pin.authority.authorityId));
  return Object.freeze({ epoch: binding?.expectedEpoch ?? null, bootId });
}

export interface NativeMobileResolveJournal {
  readonly pin: MobileRegistryOwner;
  readonly registry: (signal: AbortSignal) => {
    readonly read: () => Promise<RemoteAgentRegistry>;
    readonly update: (
      transition: (state: RemoteAgentRegistry) => RemoteAgentRegistry,
    ) => Promise<RemoteAgentRegistry>;
  };
}

/** Settle every attempted native row whose epoch provably ended; keep the rest with a reason. */
export async function resolveEndedNativeMobileAttempts(
  journal: NativeMobileResolveJournal,
  host: MobileNativeHostEvidence,
  signal: AbortSignal,
): Promise<Omit<MobileNativeResolveReport, "repair">> {
  const store = journal.registry(signal);
  const entries: MobileNativeResolveEntry[] = [];
  const before = await store.read();
  for (const attempt of attemptedNativeMobileRows(before)) {
    signal.throwIfAborted();
    const generation = attempt.nativeOwnership.assetsReference.generation;
    const planned = nativeMobileEpochEndedProof(before, attempt, host);
    if (planned.kind === "kept") {
      entries.push({ generation, outcome: "kept", reason: planned.reason });
      continue;
    }
    try {
      // The CAS re-proves on the exact state it writes; a changed row is kept, never guessed.
      const after = await store.update((state) =>
        settleEndedNativeMobileAttempt(state, journal.pin, attempt.nonce, host, Date.now()),
      );
      if (attemptedNativeMobileRows(after).some((a) => a.nonce === attempt.nonce))
        throw Error("Native settlement CAS was not acknowledged.");
      entries.push({ generation, outcome: "cleared", reason: planned.proof });
    } catch {
      entries.push({ generation, outcome: "kept", reason: "journal-inconsistent" });
    }
  }
  const final = await store.read();
  // Any unsettled row (reserved, attempted or child-owned) keeps the controller uncertain.
  const remaining =
    final.schemaVersion === 3
      ? (final.mobile.gatewayLifecycle?.attempts ?? []).filter((a) => a.phase !== "exit-confirmed")
          .length
      : 0;
  const cleared = entries.filter((e) => e.outcome === "cleared").length;
  return { cleared, kept: entries.length - cleared, unresolved: remaining, entries };
}
