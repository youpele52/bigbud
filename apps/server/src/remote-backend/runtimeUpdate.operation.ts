/**
 * The persisted single-flight runtime update operation (M3 WP-4C, D9/D10).
 *
 * - One non-terminal operation at a time (the table's UNIQUE `live` slot). Concurrent requests
 *   for the same version/source join it; a different target reconciles to it (`conflict`).
 * - Durable: every transition is a compare-and-set row update; startup resumes pending/staging
 *   operations and hands later states to the WP-4D seam.
 * - Staging drives the WP-4B archive store under the single-flight lock (`runtimeUpdate.staging`).
 * - Interruption consent is separate and single use (`runtimeUpdate.consent`).
 */
import { Effect, Fiber, Semaphore } from "effect";
import type { RemoteRuntimeUpdateRequestInput } from "@bigbud/contracts/server/remoteBackendUpdate.ts";
import {
  RemoteRuntimeUpdateOperations,
  type RemoteRuntimeUpdateRecord,
} from "../persistence/Services/RemoteRuntimeUpdateOperations.ts";
import { releaseRuntimeArchive } from "./runtimeArchive.store.ts";
import {
  consumeInterruptionConsent,
  recordInterruptionConsent,
  runtimeUpdateAffectedWorkDigest,
} from "./runtimeUpdate.consent.ts";
import { makeRuntimeUpdateLock } from "./runtimeUpdate.lock.ts";
import { runRuntimeUpdateStaging } from "./runtimeUpdate.staging.ts";
import {
  CONSENTABLE_RUNTIME_UPDATE_STATES,
  STAGING_RUNTIME_UPDATE_STATES,
  isTerminalRuntimeUpdateState,
  runtimeUpdateError,
  runtimeUpdateSourcesFor,
  toRuntimeUpdateView,
} from "./runtimeUpdate.states.ts";
import type {
  RemoteRuntimeUpdateDependencies,
  RemoteRuntimeUpdateShape,
} from "./Services/RemoteRuntimeUpdate.ts";
import type { RuntimeArchiveKey } from "./runtimeArchive.key.ts";

const now = () => new Date().toISOString();
const unavailable = () => runtimeUpdateError("unavailable", "Update state is unavailable.");
const changed = () =>
  runtimeUpdateError("invalid-state", "The update changed while handling this request; retry.");

export const makeRemoteRuntimeUpdate = Effect.fn("makeRemoteRuntimeUpdate")(function* (
  deps: RemoteRuntimeUpdateDependencies,
) {
  const repository = yield* RemoteRuntimeUpdateOperations;
  const scope = yield* Effect.scope;
  const lock = yield* makeRuntimeUpdateLock(deps.assertOwner);
  // Serializes request/consent/cancel bookkeeping; staging holds `lock`, not this.
  const admission = yield* Semaphore.make(1);
  const ctx = { repository, deps, lock, now };
  const consentDeps = {
    repository,
    now,
    affectedWork: (record: RemoteRuntimeUpdateRecord) =>
      deps.affectedWork(toRuntimeUpdateView(record)),
  };
  let inFlight:
    | {
        readonly operationId: string;
        readonly controller: AbortController;
        fiber?: Fiber.Fiber<void>;
      }
    | undefined;

  const db = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(unavailable));
  const get = (operationId: string) => db(repository.get(operationId));
  const getRequired = Effect.fn("RemoteRuntimeUpdate.getRequired")(function* (operationId: string) {
    const record = yield* get(operationId);
    if (!record) return yield* runtimeUpdateError("not-found", "No such update operation.");
    return record;
  });

  const startStaging = Effect.fn("RemoteRuntimeUpdate.startStaging")(function* (
    operationId: string,
  ) {
    const entry: NonNullable<typeof inFlight> = { operationId, controller: new AbortController() };
    inFlight = entry;
    entry.fiber = yield* runRuntimeUpdateStaging(ctx, operationId, entry.controller.signal).pipe(
      Effect.forkIn(scope),
    );
  });

  /** Releases a settled operation's reservation under the lock; idempotent. */
  const releaseUnderLock = (archiveKey: string) =>
    lock.withLock((checkpoint) =>
      Effect.tryPromise(async () => {
        const store = await deps.openStore(checkpoint);
        await releaseRuntimeArchive(store, archiveKey as RuntimeArchiveKey);
      }),
    );

  const join = Effect.fn("RemoteRuntimeUpdate.join")(function* (
    live: RemoteRuntimeUpdateRecord,
    input: RemoteRuntimeUpdateRequestInput,
  ) {
    if (live.version !== input.version || live.source !== input.source)
      return { disposition: "conflict" as const, operation: toRuntimeUpdateView(live) };
    if (!input.interrupt || live.interruptRequested)
      return { disposition: "joined" as const, operation: toRuntimeUpdateView(live) };
    // Asking for an interrupting update is recorded, but it is never consent (D9).
    const upgraded = yield* db(
      repository.compareAndSet(
        live.operationId,
        { states: [live.state] },
        { interruptRequested: true, updatedAt: now() },
      ),
    );
    return { disposition: "joined" as const, operation: toRuntimeUpdateView(upgraded ?? live) };
  });

  const request: RemoteRuntimeUpdateShape["request"] = (input) =>
    admission.withPermit(
      Effect.gen(function* () {
        const replay = yield* db(repository.findByRequestId(input.requestId));
        if (replay)
          return { disposition: "created" as const, operation: toRuntimeUpdateView(replay) };
        const live = yield* db(repository.findLive());
        if (live) return yield* join(live, input);
        const at = now();
        const inserted = yield* repository
          .insert({
            operationId: crypto.randomUUID(),
            requestId: input.requestId,
            version: input.version,
            source: input.source,
            state: "pending",
            interruptRequested: input.interrupt,
            archiveKey: null,
            consentState: "none",
            consentDigest: null,
            failure: null,
            createdAt: at,
            updatedAt: at,
          })
          .pipe(
            Effect.map((record) => ({ record, created: true })),
            Effect.catchTag("RemoteRuntimeUpdateLiveConflict", () =>
              db(repository.findLive()).pipe(Effect.map((record) => ({ record, created: false }))),
            ),
            Effect.mapError(unavailable),
          );
        if (!inserted.record) return yield* changed();
        if (!inserted.created) return yield* join(inserted.record, input);
        yield* startStaging(inserted.record.operationId);
        return { disposition: "created" as const, operation: toRuntimeUpdateView(inserted.record) };
      }),
    );

  const status: RemoteRuntimeUpdateShape["status"] = Effect.fn("RemoteRuntimeUpdate.status")(
    function* (input) {
      const record = input.operationId
        ? yield* getRequired(input.operationId)
        : ((yield* db(repository.findLive())) ?? (yield* db(repository.findLatest())));
      if (!record || !CONSENTABLE_RUNTIME_UPDATE_STATES.includes(record.state))
        return {
          operation: record ? toRuntimeUpdateView(record) : null,
          affectedWork: [],
          affectedWorkDigest: null,
        };
      const operation = toRuntimeUpdateView(record);
      const affectedWork = yield* deps.affectedWork(operation);
      return {
        operation,
        affectedWork,
        affectedWorkDigest: runtimeUpdateAffectedWorkDigest(record.operationId, affectedWork),
      };
    },
  );

  const consent: RemoteRuntimeUpdateShape["consent"] = (input) =>
    admission
      .withPermit(
        recordInterruptionConsent(consentDeps, input.operationId, input.affectedWorkDigest),
      )
      .pipe(Effect.map(toRuntimeUpdateView));

  const cancelOnce = Effect.fn("RemoteRuntimeUpdate.cancelOnce")(function* (
    record: RemoteRuntimeUpdateRecord,
  ) {
    if (record.state === "cancelled") return record;
    if (isTerminalRuntimeUpdateState(record.state) || record.state === "activating")
      return yield* runtimeUpdateError("invalid-state", "This update can no longer be cancelled.");
    const patch = { state: "cancelled" as const, updatedAt: now() };
    if (STAGING_RUNTIME_UPDATE_STATES.includes(record.state)) {
      // Staging holds the lock; it observes the abort and releases its own reservation.
      const cancelled = yield* db(
        repository.compareAndSet(
          record.operationId,
          { states: STAGING_RUNTIME_UPDATE_STATES },
          patch,
        ),
      );
      if (cancelled && inFlight?.operationId === record.operationId) inFlight.controller.abort();
      return cancelled;
    }
    return yield* lock.withLock((checkpoint) =>
      Effect.gen(function* () {
        const cancelled = yield* db(
          repository.compareAndSet(
            record.operationId,
            { states: CONSENTABLE_RUNTIME_UPDATE_STATES },
            patch,
          ),
        );
        if (cancelled?.archiveKey)
          yield* Effect.tryPromise(async () => {
            const store = await deps.openStore(checkpoint);
            await releaseRuntimeArchive(store, cancelled.archiveKey as RuntimeArchiveKey);
          }).pipe(
            // Startup's sweep retries the release of the latest settled operation.
            Effect.catch((error) => Effect.logWarning("Cancelled update release failed", error)),
          );
        return cancelled;
      }),
    );
  });

  const cancel: RemoteRuntimeUpdateShape["cancel"] = (input) =>
    admission.withPermit(
      Effect.gen(function* () {
        const first = yield* cancelOnce(yield* getRequired(input.operationId));
        // One retry covers a staging → staged race; anything else reports the new state.
        const settled = first ?? (yield* cancelOnce(yield* getRequired(input.operationId)));
        if (!settled) return yield* changed();
        return toRuntimeUpdateView(settled);
      }),
    );

  const withSingleFlight: RemoteRuntimeUpdateShape["withSingleFlight"] = (use, operationId) =>
    lock.withLock((checkpoint) =>
      Effect.gen(function* () {
        const record = yield* getRequired(operationId);
        const store = yield* Effect.tryPromise({
          try: () => deps.openStore(checkpoint),
          catch: () =>
            runtimeUpdateError("unavailable", "The runtime archive store is unavailable."),
        });
        return yield* use(store, record.archiveKey);
      }),
    );

  const advance: RemoteRuntimeUpdateShape["advance"] = Effect.fn("RemoteRuntimeUpdate.advance")(
    function* (operationId, to, failure) {
      const updated = yield* db(
        repository.compareAndSet(
          operationId,
          { states: runtimeUpdateSourcesFor(to) },
          { state: to, ...(failure === undefined ? {} : { failure }), updatedAt: now() },
        ),
      );
      if (!updated)
        return yield* runtimeUpdateError("invalid-state", `The update cannot move to ${to}.`);
      return toRuntimeUpdateView(updated);
    },
  );

  const resume = Effect.gen(function* () {
    const latest = yield* repository.findLatest();
    if (latest?.archiveKey && (latest.state === "failed" || latest.state === "cancelled"))
      yield* releaseUnderLock(latest.archiveKey);
    const live = yield* repository.findLive();
    if (!live) return;
    if (STAGING_RUNTIME_UPDATE_STATES.includes(live.state)) yield* startStaging(live.operationId);
    else if (deps.activation) yield* deps.activation.onResume(toRuntimeUpdateView(live));
  }).pipe(Effect.catch((error) => Effect.logWarning("Runtime update resume failed", error)));
  yield* resume;

  return {
    request,
    status,
    consent,
    cancel,
    withSingleFlight,
    advance,
    consumeInterruptionConsent: (operationId) =>
      consumeInterruptionConsent(consentDeps, operationId).pipe(Effect.map(toRuntimeUpdateView)),
    awaitStaging: Effect.suspend(() =>
      inFlight?.fiber ? Fiber.await(inFlight.fiber).pipe(Effect.asVoid) : Effect.void,
    ),
  } satisfies RemoteRuntimeUpdateShape;
});
