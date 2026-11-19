import type { ThreadOrganizationNativeOperation } from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";
/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `ServiceMap.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationCommand,
  CommandId,
  GetCommandOutcomeResult,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationReplayEventsResult,
  GetThreadOwnershipResult,
  OrchestrationProject,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { Effect, ServiceMap } from "effect";
import type { Scope, Stream } from "effect";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";
import type { OrchestrationCommandReceiptRepositoryError } from "../../persistence/Errors.ts";
import type { ThreadDeletionShape } from "../../deletion/Services/ThreadDeletion.ts";
import type { MetadataCommitIdentity } from "../Layers/ThreadMetadataGeneration.identity.ts";
import type { BootstrapSubmissionDispatch } from "../Layers/OrchestrationEngine.bootstrapIdentity.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /** Internal short preparation barrier; never await providers or dispatch inside it. */
  readonly withWorkspaceBarrier?: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  /** Hydrate full SQL history and prepare under one command barrier. No providers or dispatch. */
  readonly withThreadHistoryBarrier?: <A, E>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
  /** Stable identity for this server process, used to fence recovery frames. */
  readonly serverEpoch?: string;
  /** Last sequence persisted before this process started; later events are this process's. */
  readonly startupSequence?: number;

  /** Shared deletion fence and subtree operation for orchestration reactors. */
  readonly threadDeletion?: ThreadDeletionShape;

  /**
   * Read the current in-memory orchestration read model.
   *
   * @returns Effect containing the latest read model.
   */
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, never, never>;

  /** Hydrates under the command barrier (waits for the in-flight command first). */
  readonly ensureThreadState?: (
    threadId: ThreadId,
    level: "operational" | "history",
  ) => Effect.Effect<OrchestrationThread | undefined>;

  /**
   * The thread by id: the resident one without waiting, else hydrated from durable projections
   * (the startup window leaves settled threads out and idle threads are evicted). Use through
   * `getOrchestrationThread`, never `getReadModel().threads.find`.
   */
  readonly getThread?: (
    threadId: ThreadId,
    level: "operational" | "history",
  ) => Effect.Effect<OrchestrationThread | undefined>;

  /** Hydrates every thread of the project that is not deleted; returns its resident threads. */
  readonly ensureProjectThreads?: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThread>>;

  /** Hydrates the thread and its live descendants; returns every resident thread. */
  readonly ensureThreadSubtree?: (
    rootThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThread>>;

  /** Ids of the project's threads that are not deleted, straight from the projections. */
  readonly listProjectThreadIds?: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<ThreadId>>;

  /**
   * Evicts idle resident threads (`OrchestrationEngine.residency.ts`). `isHeld` reports outside
   * interest (a live provider session, an open terminal); a held thread is kept.
   */
  readonly evictIdleThreads?: (input: {
    readonly isHeld: (threadId: ThreadId) => Effect.Effect<boolean>;
  }) => Effect.Effect<{ readonly evicted: number; readonly resident: number }>;

  /** Installs a project the startup window left out (an idle project) from durable projections. */
  readonly ensureProjectState?: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationProject | undefined>;

  /** Installs and returns every live project that uses this workspace root. */
  readonly ensureWorkspaceProjects?: (
    workspaceRoot: string,
  ) => Effect.Effect<ReadonlyArray<OrchestrationProject>>;

  readonly resolveThreadOwnership?: (threadId: ThreadId) => Effect.Effect<GetThreadOwnershipResult>;

  readonly getCommandOutcome?: (
    commandId: CommandId,
  ) => Effect.Effect<GetCommandOutcomeResult, OrchestrationCommandReceiptRepositoryError>;

  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  readonly readReplay: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Effect.Effect<OrchestrationReplayEventsResult, OrchestrationEventStoreError>;

  /** A bounded live handoff plus an eager overflow probe for replay markers. */
  readonly openDeliveryLiveCapture?: (
    capacity?: number,
    maxBytes?: number,
  ) => Effect.Effect<OrchestrationDeliveryLiveCapture, never, Scope.Scope>;

  /** Internal keyed lookup for the event set committed by one command. */
  readonly readEventsByCommandId?: (
    commandId: CommandId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, OrchestrationEventStoreError>;

  /** Lowest read cursor of an open internal reactor stream, or null when none is open. */
  readonly oldestReactorCursor?: () => number | null;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
    options?: {
      readonly bootstrapSubmission?: BootstrapSubmissionDispatch;
      /** Trusted retained-result fence; never decoded from a client or provider command. */
      readonly metadataCommit?: MetadataCommitIdentity;
      readonly worktreeOperationId?: string;
      /** Server-only exact verified native workspace journal identity; never accepted over the wire. */
      readonly nativeWorkspaceOperationId?: string;
      readonly nativeOrganizationOperation?: ThreadOrganizationNativeOperation;
      readonly expectedWorktreePath?: { readonly value: string | null };
      readonly expectedWorktreeIdentity?: { readonly path: string; readonly identity: string };
    },
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;
}

export interface OrchestrationDeliveryLiveCapture {
  readonly stream: Stream.Stream<OrchestrationEvent>;
  /** Reads capture state without waiting for the live stream to be consumed. */
  readonly isOverflowed: Effect.Effect<boolean>;
  /** Closes the capture before its owning stream scope is finalized. */
  readonly close: Effect.Effect<void>;
}

export function ensureOrchestrationThreadState(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
  level: "operational" | "history",
) {
  return engine.ensureThreadState
    ? engine.ensureThreadState(threadId, level)
    : engine
        .getReadModel()
        .pipe(Effect.map((model) => model.threads.find((thread) => thread.id === threadId)));
}

/**
 * The one way to read a thread by id outside the command barrier. A resident thread is returned
 * as is (identical to a direct read-model lookup); a missing one is hydrated, so a thread the
 * startup window left out or eviction removed is never mistaken for an absent one.
 */
export function getOrchestrationThread(
  engine: Pick<OrchestrationEngineShape, "getThread" | "getReadModel" | "ensureThreadState">,
  threadId: ThreadId,
  level: "operational" | "history" = "operational",
): Effect.Effect<OrchestrationThread | undefined> {
  if (engine.getThread) return engine.getThread(threadId, level);
  const ensureThreadState = engine.ensureThreadState;
  // Hosts with only the barrier hydrator: resident first, else hydrate.
  return engine.getReadModel().pipe(
    Effect.map((model) => model.threads.find((thread) => thread.id === threadId)),
    Effect.flatMap((resident) =>
      resident !== undefined || ensureThreadState === undefined
        ? Effect.succeed(resident)
        : ensureThreadState(threadId, level),
    ),
  );
}

/**
 * The thread (hydrated if needed) together with the read model it was read from, for callers
 * that also need the snapshot sequence or the thread's project. The accessor's touch keeps the
 * thread resident for at least `READ_MODEL_MIN_RESIDENCY_MS`, so the second read still holds it.
 */
export function getOrchestrationThreadWithReadModel(
  engine: Pick<OrchestrationEngineShape, "getThread" | "getReadModel" | "ensureThreadState">,
  threadId: ThreadId,
  level: "operational" | "history" = "operational",
): Effect.Effect<{
  readonly readModel: OrchestrationReadModel;
  readonly thread: OrchestrationThread | undefined;
}> {
  return getOrchestrationThread(engine, threadId, level).pipe(
    Effect.flatMap((hydrated) =>
      engine.getReadModel().pipe(
        Effect.map((readModel) => ({
          readModel,
          thread:
            hydrated === undefined
              ? undefined
              : (readModel.threads.find((thread) => thread.id === threadId) ?? hydrated),
        })),
      ),
    ),
  );
}

/** Every thread of a project that is not deleted (hydrated), plus deleted ones still resident. */
export function ensureOrchestrationProjectThreads(
  engine: Pick<OrchestrationEngineShape, "ensureProjectThreads" | "getReadModel">,
  projectId: ProjectId,
): Effect.Effect<ReadonlyArray<OrchestrationThread>> {
  return engine.ensureProjectThreads
    ? engine.ensureProjectThreads(projectId)
    : engine
        .getReadModel()
        .pipe(
          Effect.map((model) => model.threads.filter((thread) => thread.projectId === projectId)),
        );
}

/** Resident threads after hydrating `rootThreadId` and its live descendants. */
export function ensureOrchestrationThreadSubtree(
  engine: Pick<OrchestrationEngineShape, "ensureThreadSubtree" | "getReadModel">,
  rootThreadId: ThreadId,
): Effect.Effect<ReadonlyArray<OrchestrationThread>> {
  return engine.ensureThreadSubtree
    ? engine.ensureThreadSubtree(rootThreadId)
    : engine.getReadModel().pipe(Effect.map((model) => model.threads));
}

/** Ids of a project's threads that are not deleted, without loading the threads. */
export function listOrchestrationProjectThreadIds(
  engine: Pick<OrchestrationEngineShape, "listProjectThreadIds" | "getReadModel">,
  projectId: ProjectId,
): Effect.Effect<ReadonlyArray<ThreadId>> {
  return engine.listProjectThreadIds
    ? engine.listProjectThreadIds(projectId)
    : engine
        .getReadModel()
        .pipe(
          Effect.map((model) =>
            model.threads
              .filter((thread) => thread.projectId === projectId && thread.deletedAt === null)
              .map((thread) => thread.id),
          ),
        );
}

/**
 * A project by id, hydrated when the startup window left it out. Read-model lookups of a
 * project before a dispatch go through this, never `getReadModel().projects` alone.
 */
export function ensureOrchestrationProjectState(
  engine: Pick<OrchestrationEngineShape, "ensureProjectState" | "getReadModel">,
  projectId: ProjectId,
) {
  return engine.ensureProjectState
    ? engine.ensureProjectState(projectId)
    : engine
        .getReadModel()
        .pipe(Effect.map((model) => model.projects.find((project) => project.id === projectId)));
}

/** Live (not deleted, not being deleted) projects using a workspace root, hydrated if needed. */
export function ensureOrchestrationWorkspaceProjects(
  engine: Pick<OrchestrationEngineShape, "ensureWorkspaceProjects" | "getReadModel">,
  workspaceRoot: string,
) {
  return (
    engine.ensureWorkspaceProjects
      ? engine.ensureWorkspaceProjects(workspaceRoot)
      : engine
          .getReadModel()
          .pipe(
            Effect.map((model) =>
              model.projects.filter((project) => project.workspaceRoot === workspaceRoot),
            ),
          )
  ).pipe(
    Effect.map((projects) =>
      projects.filter((project) => project.deletedAt === null && !project.deletingAt),
    ),
  );
}

export function resolveOrchestrationThreadOwnership(
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
) {
  return engine.resolveThreadOwnership
    ? engine.resolveThreadOwnership(threadId)
    : Effect.succeed({
        threadId,
        status: "unavailable" as const,
        ownership: "unconfirmed" as const,
        reason: "Canonical ownership resolution is unavailable.",
      });
}

export function getOrchestrationCommandOutcome(
  engine: OrchestrationEngineShape,
  commandId: CommandId,
): Effect.Effect<GetCommandOutcomeResult, OrchestrationCommandReceiptRepositoryError> {
  return engine.getCommandOutcome
    ? engine.getCommandOutcome(commandId)
    : Effect.succeed({
        commandId,
        status: "unknown" as const,
        serverEpoch: "unavailable",
        canonicalRevision: 0,
      });
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.getReadModel()
 * })
 * ```
 */
export class OrchestrationEngineService extends ServiceMap.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
