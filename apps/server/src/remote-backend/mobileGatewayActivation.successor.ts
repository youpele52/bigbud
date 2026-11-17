/**
 * Successor recovery of an original native mobile gateway after its controller (this backend's
 * predecessor) died. Orchestration ports only; the actual native client owns every opaque token,
 * correlation and verification. Native contract (two Resumes, no new protocol fields):
 *
 * - Resume #1 proves the prior controller dead, classifies the original gateway and clears the
 *   exact stale upstream socket. It returns "attaching" plus the private bootstrap credential.
 * - The successor binds, serves and seals a new upstream socket with that credential.
 * - Resume #2 verifies the new socket and the still-live gateway before "spawned".
 *
 * Nothing here grants consent: consent-off flows only through the canonical journal, native stop
 * and confirmed exit. Nothing here reports readiness except a verified Resume #2.
 */
export type MobileSuccessorResumption<A, L> =
  | { readonly state: "live"; readonly lease: L }
  | { readonly state: "attaching"; readonly attaching: A };

export interface MobileSuccessorNativePort<A extends object, L extends object, E extends object> {
  /** Resume #1 for this attempt's retained original lease, before any socket side effect. */
  readonly resume: (signal: AbortSignal) => Promise<MobileSuccessorResumption<A, L>>;
  /** Resume #2 after the new upstream socket is sealed. */
  readonly attach: (attaching: A, signal: AbortSignal) => Promise<MobileSuccessorResumption<A, L>>;
  /** Private bootstrap credential of the original launch. Never logged or persisted. */
  readonly credential: (attaching: A) => string;
  /** Read-only native status: only confirmed exit evidence settles a gone gateway. */
  readonly reconcile: (
    signal: AbortSignal,
  ) => Promise<{ readonly kind: "exited"; readonly exit: E } | { readonly kind: "unsettled" }>;
  /** Exact original-scope stop; resolves only with confirmed exit evidence. */
  readonly stop: (signal: AbortSignal) => Promise<E>;
}
export interface MobileSuccessorUpstream {
  readonly release: () => Promise<void>;
}
export interface MobileSuccessorRecovery<
  A extends object,
  L extends object,
  E extends object,
  U extends MobileSuccessorUpstream,
> {
  readonly native: MobileSuccessorNativePort<A, L, E>;
  /** Canonical CAS consent journal. A throw is unknown consent, never "on". */
  readonly consented: (signal: AbortSignal) => Promise<boolean>;
  /** Existing private socket helper: refuse an existing path, serve, then seal. */
  readonly serveUpstream: (credential: string, signal: AbortSignal) => Promise<U>;
  /** Existing same-CAS exit settlement for confirmed native exit evidence. */
  readonly recordExit: (exit: E, signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
}
export type MobileSuccessorUncertainty =
  | "consent-unknown"
  | "legacy-native"
  | "native-unsettled"
  | "upstream-unavailable"
  | "upstream-unreleased"
  | "exit-unrecorded";
export type MobileSuccessorOutcome<L, U> =
  /** Native verified the new socket and live gateway; the caller now owns `upstream`. */
  | { readonly kind: "ready"; readonly lease: L; readonly upstream: U }
  /** The original gateway is gone and its exit is recorded; only a fresh Start may follow. */
  | { readonly kind: "exited" }
  /** Consent is off: native stop confirmed the exit and the journal recorded it. */
  | { readonly kind: "revoked" }
  /** Native has not observed the new socket; neither ready nor failed. Native is untouched. */
  | { readonly kind: "unready" }
  /** Preserve native ownership, assets and pins for repair. */
  | { readonly kind: "uncertain"; readonly reason: MobileSuccessorUncertainty };

export type MobileSuccessorStep =
  | { readonly resume: 1 | 2; readonly result: "live" | "attaching" | "failed" }
  | { readonly consent: "on" | "off" | "unknown" };
export type MobileSuccessorDecision =
  | "continue"
  | "serve-upstream"
  | "ready"
  | "unready"
  | "settle-exit"
  | "revoke"
  | "legacy-native"
  | "consent-unknown";

/** Pure mapping of each observed step to the next action. */
export function mobileSuccessorDecision(step: MobileSuccessorStep): MobileSuccessorDecision {
  if ("consent" in step)
    return step.consent === "on"
      ? "continue"
      : step.consent === "off"
        ? "revoke"
        : "consent-unknown";
  if (step.result === "failed") return "settle-exit"; // Only confirmed exit evidence settles.
  if (step.resume === 1) return step.result === "attaching" ? "serve-upstream" : "legacy-native";
  return step.result === "live" ? "ready" : "unready";
}

const uncertain = (reason: MobileSuccessorUncertainty) =>
  Object.freeze({ kind: "uncertain" as const, reason });

/** One successor attempt for one retained original lease. Never retries or starts fresh. */
export async function runMobileSuccessorRecovery<
  A extends object,
  L extends object,
  E extends object,
  U extends MobileSuccessorUpstream,
>(input: MobileSuccessorRecovery<A, L, E, U>): Promise<MobileSuccessorOutcome<L, U>> {
  const native = input.native,
    signal = input.signal;
  const settle = async (
    exit: E,
    kind: "exited" | "revoked",
  ): Promise<MobileSuccessorOutcome<L, U>> => {
    try {
      await input.recordExit(exit, signal);
    } catch {
      return uncertain("exit-unrecorded");
    }
    return { kind };
  };
  const revoke = async () => {
    let exit: E;
    try {
      exit = await native.stop(signal);
    } catch {
      return uncertain("native-unsettled");
    }
    return settle(exit, "revoked");
  };
  const failed = async () => {
    try {
      const status = await native.reconcile(signal);
      if (status.kind === "exited") return settle(status.exit, "exited");
    } catch {
      // Lost or refused observation is not exit evidence.
    }
    return uncertain("native-unsettled");
  };
  const consent = async (): Promise<MobileSuccessorDecision> => {
    try {
      return mobileSuccessorDecision({ consent: (await input.consented(signal)) ? "on" : "off" });
    } catch {
      return mobileSuccessorDecision({ consent: "unknown" });
    }
  };
  /** Returns undefined to continue, otherwise the terminal outcome for revoked/unknown consent. */
  const gate = async () => {
    const decision = await consent();
    if (decision === "revoke") return revoke();
    if (decision === "consent-unknown") return uncertain("consent-unknown");
    return undefined;
  };

  const before = await gate();
  if (before) return before;
  let first: MobileSuccessorResumption<A, L>;
  try {
    first = await native.resume(signal);
  } catch {
    return failed();
  }
  // A native without receipts never verified the stale or new socket: never report it ready.
  const resumed = mobileSuccessorDecision({ resume: 1, result: first.state });
  if (resumed !== "serve-upstream" || first.state !== "attaching")
    return uncertain("legacy-native");
  const attaching = first.attaching;

  const held: { upstream?: U } = {};
  const attach = async (): Promise<MobileSuccessorOutcome<L, U>> => {
    const gated = await gate();
    if (gated) return gated;
    let upstream: U;
    try {
      upstream = await input.serveUpstream(native.credential(attaching), signal);
      held.upstream = upstream;
    } catch {
      return uncertain("upstream-unavailable");
    }
    const sealed = await gate();
    if (sealed) return sealed;
    let second: MobileSuccessorResumption<A, L>;
    try {
      second = await native.attach(attaching, signal);
    } catch {
      // Native guard refusal may be revocation racing this read; consent decides first.
      return (await gate()) ?? failed();
    }
    const verified = mobileSuccessorDecision({ resume: 2, result: second.state });
    if (verified !== "ready" || second.state !== "live") return { kind: "unready" };
    // Consent is read last, immediately before readiness can reach the caller.
    const ready = await gate();
    if (ready) return ready;
    return { kind: "ready", lease: second.lease, upstream };
  };
  const outcome = await attach();
  if (outcome.kind === "ready" || !held.upstream) return outcome;
  // Native stop (if any) has already settled; only now withdraw the credential-bearing socket.
  try {
    await held.upstream.release();
  } catch {
    return outcome.kind === "uncertain" ? outcome : uncertain("upstream-unreleased");
  }
  return outcome;
}
