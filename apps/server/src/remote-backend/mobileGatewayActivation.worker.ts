import * as Data from "effect/Data";

/** Orchestration ports only. Actual native client owns every opaque token/verification. */
export interface MobileActivationNativePort<
  S,
  P extends object,
  L extends object,
  E extends object,
  N extends object,
> {
  readonly prepareStart: (selection: S) => P;
  readonly start: (pending: P, signal: AbortSignal) => Promise<L>;
  readonly reconcile: (
    pending: P,
    signal: AbortSignal,
  ) => Promise<
    | { readonly kind: "lease"; readonly lease: L }
    // This evidence must fence late original Start, never merely report absent-now.
    | { readonly kind: "notAccepted"; readonly evidence: N }
    | { readonly kind: "uncertain" }
  >;
  readonly detach: (lease: L) => Promise<void>;
  readonly stop: (lease: L) => Promise<E>;
}
export class MobileActivationWorkerRepair extends Data.TaggedError("MobileActivationWorkerRepair")<{
  readonly message: string;
  readonly cause: unknown;
}> {}
export interface MobileActivationWorker<
  S,
  P extends object,
  L extends object,
  E extends object,
  N extends object,
  A,
> {
  readonly native: MobileActivationNativePort<S, P, L, E, N> | undefined;
  readonly detach: AbortSignal;
  readonly stop: AbortSignal;
  /** Actual composition holds original publication scope and current consent, never a JSON path. */
  readonly withSelection: (signal: AbortSignal, use: (selection: S) => Promise<A>) => Promise<A>;
  /** Durable same-CAS intent/pin must settle BEFORE invoking native Start. */
  readonly reserve: (pending: P, selection: S, signal: AbortSignal) => Promise<void>;
  readonly cancelUnlaunched: (pending: P, signal: AbortSignal) => Promise<void>;
  readonly cancelRejected: (pending: P, evidence: N, signal: AbortSignal) => Promise<void>;
  readonly recordExit: (pending: P, lease: L, exit: E, signal: AbortSignal) => Promise<void>;
  /** Owns probes/HTTP work and settles before returning. This worker emits no readiness value. */
  readonly use: (lease: L, signal: AbortSignal) => Promise<A>;
}
type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly cause: unknown };
const outcome = <A>(work: Promise<A>): Promise<Outcome<A>> =>
  work.then(
    (value): Outcome<A> => ({ ok: true, value }),
    (cause: unknown): Outcome<A> => ({ ok: false, cause }),
  );
export type MobileActivationWorkerResult<A> =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "completed";
      readonly disposition: "detached" | "exit-recorded";
      readonly value: A;
    };

/** One original attempt. Every retry needs a fresh durable permit outside this worker. */
export async function runMobileActivationWorker<
  S,
  P extends object,
  L extends object,
  E extends object,
  N extends object,
  A,
>(input: MobileActivationWorker<S, P, L, E, N, A>): Promise<MobileActivationWorkerResult<A>> {
  const supplied = input.native;
  // Do not inspect selectors, settings, keys, FS or transport callbacks without an adapter.
  if (!supplied) return { kind: "unavailable" };
  const native = Object.freeze({
    prepareStart: supplied.prepareStart.bind(supplied),
    start: supplied.start.bind(supplied),
    reconcile: supplied.reconcile.bind(supplied),
    detach: supplied.detach.bind(supplied),
    stop: supplied.stop.bind(supplied),
  });
  const detach = input.detach,
    stop = input.stop;
  const withSelection = input.withSelection.bind(input),
    reserve = input.reserve.bind(input),
    cancelUnlaunched = input.cancelUnlaunched.bind(input),
    cancelRejected = input.cancelRejected.bind(input),
    recordExit = input.recordExit.bind(input),
    use = input.use.bind(input);
  const scopeAbort = new AbortController();
  const signal = AbortSignal.any([detach, stop, scopeAbort.signal]);
  signal.throwIfAborted();
  let heldLease = false,
    exitRecorded = false;
  const execute = async (selection: S) => {
    const pending = native.prepareStart(selection);
    const cleanup = new AbortController().signal;
    let invoked = false,
      lease: L | undefined;
    const work = await outcome(
      (async () => {
        await reserve(pending, selection, signal);
        signal.throwIfAborted();
        invoked = true; // No asynchronous gap between this fence and original Start invocation.
        try {
          lease = await native.start(pending, signal);
        } catch (cause) {
          const resolution = await Promise.resolve()
            .then(() => native.reconcile(pending, cleanup))
            .catch((reconcileCause: unknown) => {
              throw new MobileActivationWorkerRepair({
                message: "Original native Start reconciliation failed; preserve intent and pin.",
                cause: new AggregateError([cause, reconcileCause]),
              });
            });
          if (resolution.kind === "uncertain")
            throw new MobileActivationWorkerRepair({
              message: "Original native Start remains uncertain; preserve intent and pin.",
              cause,
            });
          if (resolution.kind === "notAccepted") {
            await Promise.resolve()
              .then(() => cancelRejected(pending, resolution.evidence, cleanup))
              .catch((cancelCause: unknown) => {
                throw new MobileActivationWorkerRepair({
                  message: "Original native cancellation CAS remains uncertain.",
                  cause: new AggregateError([cause, cancelCause]),
                });
              });
            throw cause;
          }
          lease = resolution.lease;
        }
        heldLease = true;
        signal.throwIfAborted();
        return use(lease, signal);
      })(),
    );
    const failures: unknown[] = [];
    const stopOriginal = async (owned: L) => {
      try {
        const exit = await native.stop(owned);
        await recordExit(pending, owned, exit, cleanup);
        exitRecorded = true;
      } catch (cause) {
        failures.push(cause);
      }
    };
    if (lease) {
      let stopAttempted = false;
      if (stop.aborted || !detach.aborted) {
        stopAttempted = true;
        await stopOriginal(lease);
      }
      // Settle Node/proxy IO even if exact child stop/CAS failed; never turn it into exit evidence.
      try {
        await native.detach(lease);
      } catch (cause) {
        failures.push(cause);
      }
      if (!stopAttempted && stop.aborted) await stopOriginal(lease);
    } else if (!invoked) {
      try {
        await cancelUnlaunched(pending, cleanup);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length)
      throw new MobileActivationWorkerRepair({
        message: "Original native cleanup did not settle; preserve uncertain ownership.",
        cause: new AggregateError([...(work.ok ? [] : [work.cause]), ...failures]),
      });
    if (!work.ok) throw work.cause;
    return work.value;
  };
  let accepted: Promise<A> | undefined,
    callbackSettled = false,
    selectionClosed = false;
  const selected = await outcome(
    Promise.resolve().then(() =>
      withSelection(signal, (selection) => {
        if (selectionClosed) {
          const rejected = Promise.reject(
            new MobileActivationWorkerRepair({
              message: "Selection scope has already retired.",
              cause: undefined,
            }),
          );
          void rejected.catch(() => {});
          return rejected;
        }
        if (accepted) {
          const cause = new MobileActivationWorkerRepair({
            message: "Selection callback may be accepted only once.",
            cause: undefined,
          });
          scopeAbort.abort(cause);
          const rejected = Promise.reject(cause);
          void rejected.catch(() => {});
          return rejected;
        }
        accepted = Promise.resolve()
          .then(() => execute(selection))
          .finally(() => {
            callbackSettled = true;
          });
        void accepted.catch(() => {});
        return accepted;
      }),
    ),
  );
  selectionClosed = true;
  let escaped: MobileActivationWorkerRepair | undefined;
  if (accepted && !callbackSettled) {
    escaped = new MobileActivationWorkerRepair({
      message: "Selection scope returned before accepted native work settled.",
      cause: selected.ok ? undefined : selected.cause,
    });
    scopeAbort.abort(escaped);
  }
  const callbackOutcome = accepted ? await outcome(accepted) : undefined;
  if (escaped) throw escaped;
  if (selected.ok && callbackOutcome && !callbackOutcome.ok) throw callbackOutcome.cause;
  if (selected.ok && !accepted)
    throw new MobileActivationWorkerRepair({
      message: "Original selection callback was not held by its scope.",
      cause: undefined,
    });
  // Revocation racing publication-scope retirement cannot be misreported as native cleanup.
  if (heldLease && stop.aborted && !exitRecorded)
    throw new MobileActivationWorkerRepair({
      message: "Explicit stop raced detached native ownership; original exit remains required.",
      cause: selected.ok ? undefined : selected.cause,
    });
  if (!selected.ok) throw selected.cause;
  return {
    kind: "completed",
    disposition: exitRecorded ? "exit-recorded" : "detached",
    value: selected.value,
  };
}
