import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { BackendInstance } from "../startup/backendInstance.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { makeThreadOrganizationRuntimeRepository } from "../persistence/Layers/ThreadOrganizationRuntime.ts";
import { makeThreadOrganizationOperations } from "../persistence/Layers/ThreadOrganizationOperations.ts";
import { makeOrganizationOwnerFacts } from "./organizationFacts.owners.ts";
import { makeOrganizationFactStore } from "./organizationFacts.store.ts";
import { makeOrganizationSnapshotCapture } from "./organizationSnapshot.capture.ts";
import { installOrganizationOwner, type OrganizationOwner } from "./organizationOwner.ts";
import { OrganizationObservation } from "./organizationObservation.ts";
import { consumeOrganizationCapture } from "./organizationBridge.capture.ts";
import { setOrganizationStatus } from "./organizationStatus.ts";
import { organizationNativeBinary } from "./organizationNative.config.ts";
import { OrganizationNativeProcess } from "./organizationNative.process.ts";
import { encodeCompactSnapshot } from "./organizationSnapshot.ts";
import { OrganizationNativeFault } from "./organizationLifecycle.ts";
import { OrganizationFailureGate } from "./organizationBridge.failure.ts";
import {
  ORGANIZATION_LIMITS,
  type OrganizationFrame,
  type OrganizationNativeFrame,
  type OrganizationProposal,
} from "./organizationProtocol.ts";
import { makeOrganizationPublisher } from "./organizationBridge.publisher.ts";
import { makeOrganizationProposalHandler } from "./organizationBridge.proposals.ts";
import {
  readOrganizationInstallation,
  reconcileOrganizationPolicy,
  recoverOrganizationOperations,
} from "./organizationBridge.startup.ts";
import {
  makeOrganizationPolicyFollower,
  organizationIdleNotBefore,
} from "./organizationBridge.policy.ts";
import {
  makeOrganizationHeartbeat,
  makeOrganizationLedgerPruner,
  makeOrganizationObservationPass,
  ORGANIZATION_BRIDGE_TIMING as T,
  type OrganizationNativeLiveness,
} from "./organizationBridge.loops.ts";

const asError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error : new Error("organisation bridge failure");
};
/** Rust holds at most one proposal plus three identical retransmissions. */
const PROPOSAL_QUEUE = 32;

/** TS supplies observations and executes validated commands. Only Rust selects moves/deadlines.
 * Independent fibers own liveness, observation, policy and proposals; any failure fences the
 * owner first and ends this attempt. Resynchronisation never activates a TS scheduler.
 */
export const makeOrganizationBridge = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const terminal = yield* Effect.serviceOption(TerminalManager);
  const backend = yield* BackendInstance;
  const engine = yield* OrchestrationEngineService;
  const settingsService = yield* ServerSettingsService;
  const owners = yield* makeOrganizationOwnerFacts;
  const runtime = yield* makeThreadOrganizationRuntimeRepository;
  const operations = yield* makeThreadOrganizationOperations;
  const facts = makeOrganizationFactStore({ sql, owners, now: Date.now });
  const snapshot = makeOrganizationSnapshotCapture({ sql, owners });
  const pruneLedger = makeOrganizationLedgerPruner({ prune: operations.prune });
  let generation = 0;

  const run = Effect.fn("OrganizationBridge.run")(function* () {
    if (!engine.openDeliveryLiveCapture)
      return yield* Effect.fail(new Error("organisation live capture unavailable"));
    const capture = yield* engine.openDeliveryLiveCapture(2000, 8 * 1024 * 1024);
    const observations = new OrganizationObservation();
    const failed = yield* Deferred.make<never, Error>();
    let owner: OrganizationOwner | undefined;
    const gate = new OrganizationFailureGate((error) => {
      if (owner) owner.active = false;
      Deferred.doneUnsafe(failed, Effect.fail(error));
    });
    const fail = (error: Error) => gate.fail(error);
    const guard = (effect: Effect.Effect<unknown, Error>) =>
      effect.pipe(Effect.catchCause((cause) => Effect.sync(() => fail(asError(cause)))));
    // Assigned once the policy follower exists; earlier hints fall to its 30s fallback, and
    // acceptance always rechecks the stored barrier.
    let markBarrier: (() => void) | undefined;
    const forget = Option.isSome(terminal) ? terminal.value.forgetThreadIdleWork : undefined;
    yield* Effect.forkScoped(
      guard(
        consumeOrganizationCapture({
          stream: capture.stream,
          isOverflowed: capture.isOverflowed,
          observations,
          ...(forget ? { forget } : {}),
          onDeliberateOrganization: () => markBarrier?.(),
        }),
      ),
    );
    const settings = yield* settingsService.getSettings;
    const classification = yield* readOrganizationInstallation(sql);
    const policy = yield* reconcileOrganizationPolicy(
      runtime,
      settings,
      classification,
      Date.now(),
    );
    yield* recoverOrganizationOperations(engine, operations);
    let graceMs = settings.inyosiraGraceMinutes * 60000;
    const compact = yield* snapshot(graceMs);
    const binary = organizationNativeBinary();
    if (!binary) return yield* Effect.fail(new Error("organisation binary unavailable"));
    generation += 1;
    const epoch = { backendNonce: backend.nonce, generation };
    const rows = new Map(compact.rows.map((row) => [row.threadId, row]));
    const launchedAt = Date.now();
    const liveOwner: OrganizationOwner = {
      ...epoch,
      active: false,
      observedAtMs: launchedAt,
      policy: policy.wire,
      rows,
      idleNotBeforeMs: organizationIdleNotBefore(
        launchedAt,
        policy.stored,
        settings.inyosiraIdleTimeoutMinutes * 60000,
      ),
      observe: (ids) => ids.forEach((id) => observations.mark(id)),
    };
    owner = liveOwner;
    const uninstall = installOrganizationOwner(sql, liveOwner);
    yield* Effect.addFinalizer(() => Effect.sync(uninstall));
    const liveness: OrganizationNativeLiveness = {
      ready: false,
      launchedAt,
      progressAt: launchedAt,
      lastNativeAt: launchedAt,
    };
    const proposals = yield* Queue.dropping<OrganizationProposal>(PROPOSAL_QUEUE);
    // The receiver only admits and enqueues; outcomes travel in receipts. Slow canonical
    // acceptance therefore never trips the transport's per-frame receive bound.
    const receive = (frame: OrganizationNativeFrame) => {
      liveness.lastNativeAt = Date.now();
      if (frame.type === "ready") {
        if (frame.sequence !== 1 || frame.policyVersion !== liveOwner.policy.version)
          return Promise.reject(new Error("organisation activation frontier mismatch"));
        liveness.ready = true;
        liveOwner.active = true;
        setOrganizationStatus(sql, "healthy");
      } else if (frame.type === "proposal") {
        if (!liveness.ready || !liveOwner.active)
          return Promise.reject(new Error("organisation proposal before activation"));
        if (!Queue.offerUnsafe(proposals, frame.value))
          return Promise.reject(new Error("organisation proposal queue overflow"));
      }
      return Promise.resolve();
    };
    const child = new OrganizationNativeProcess({ ...epoch, binary, failed: fail, receive });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        liveOwner.active = false;
      }).pipe(Effect.andThen(Effect.promise(() => child.stop()))),
    );
    const send = (frame: OrganizationFrame) =>
      Effect.tryPromise({
        try: () => child.send(frame),
        catch: (error) =>
          new OrganizationNativeFault({
            message: "organisation native write failed",
            cause: error,
          }),
      });
    const publisher = makeOrganizationPublisher({
      sql,
      epoch,
      graceMs: () => graceMs,
      rows,
      observations,
      observe: facts.observe,
      send,
      initial: { sequence: 1, frontier: compact.frontier },
    });
    const handle = makeOrganizationProposalHandler({
      epoch,
      engine,
      operations,
      refresh: publisher.refresh,
      send,
    });
    const every = (ms: number, step: Effect.Effect<unknown, Error>) =>
      Effect.forkScoped(guard(Effect.forever(step.pipe(Effect.andThen(Effect.sleep(ms))))));
    child.start();
    yield* every(
      T.heartbeatMs,
      makeOrganizationHeartbeat({
        owner: liveOwner,
        liveness,
        state: publisher.state,
        send,
        resync: fail,
      }),
    );
    yield* send({
      ...epoch,
      type: "hello",
      value: { major: 1, minor: 0, capability: "compact-facts-v1", limits: ORGANIZATION_LIMITS },
    });
    for (const frame of encodeCompactSnapshot(
      epoch,
      {
        snapshotId: `${backend.nonce}:${generation}`,
        sequence: 1,
        sourceFrontier: compact.frontier,
        policy: policy.wire,
      },
      compact.rows,
    )) {
      yield* send(frame);
      liveness.progressAt = Date.now();
    }
    yield* Effect.forkScoped(
      guard(
        Effect.forever(
          Queue.take(proposals).pipe(
            Effect.tap(() => Effect.sync(() => gate.proposalStarted())),
            Effect.flatMap(handle),
            Effect.ensuring(Effect.sync(() => gate.proposalSettled())),
          ),
        ),
      ),
    );
    yield* every(
      T.observationMs,
      makeOrganizationObservationPass({
        sql,
        liveness,
        observations,
        captureOverflowed: capture.isOverflowed,
        refresh: publisher.refresh,
        published: () => rows.keys(),
      }),
    );
    const follower = makeOrganizationPolicyFollower({
      runtime,
      settings: settingsService,
      classification,
      owner: liveOwner,
      launchedAtMs: launchedAt,
      proposalInFlight: () => gate.inFlight,
      send,
      onGrace: (value) => (graceMs = value),
    });
    markBarrier = follower.markBarrier;
    yield* every(
      T.heartbeatMs,
      Effect.suspend(() => (liveness.ready ? follower.step : Effect.void)),
    );
    // Housekeeping after activation only; the pruner paces itself and never fails the attempt.
    yield* every(
      T.sweepMs,
      Effect.suspend(() => (liveness.ready ? pruneLedger : Effect.void)),
    );
    return yield* Deferred.await(failed);
  });
  return { run };
});
