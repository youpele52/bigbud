import { IsoDateTime, MessageId, ThreadId, TrimmedNonEmptyString } from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const ProjectionThreadWatchStatus = Schema.Literals(["active", "triggered", "cancelled"]);
export type ProjectionThreadWatchStatus = typeof ProjectionThreadWatchStatus.Type;

export const ProjectionThreadWatch = Schema.Struct({
  watchId: TrimmedNonEmptyString,
  watcherThreadId: ThreadId,
  watchedThreadId: ThreadId,
  watchedThreadTitle: TrimmedNonEmptyString,
  sourceMessageId: MessageId,
  status: ProjectionThreadWatchStatus,
  createdAt: IsoDateTime,
  triggeredAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThreadWatch = typeof ProjectionThreadWatch.Type;

export const ReplaceActiveThreadWatchesInput = Schema.Struct({
  watcherThreadId: ThreadId,
  sourceMessageId: MessageId,
  watches: Schema.Array(
    Schema.Struct({
      watchedThreadId: ThreadId,
      watchedThreadTitle: TrimmedNonEmptyString,
    }),
  ),
  createdAt: IsoDateTime,
});
export type ReplaceActiveThreadWatchesInput = typeof ReplaceActiveThreadWatchesInput.Type;

export const ListActiveThreadWatchesByWatchedThreadInput = Schema.Struct({
  watchedThreadId: ThreadId,
});
export type ListActiveThreadWatchesByWatchedThreadInput =
  typeof ListActiveThreadWatchesByWatchedThreadInput.Type;

export const ListActiveThreadWatchesByWatcherAndMessageInput = Schema.Struct({
  watcherThreadId: ThreadId,
  sourceMessageId: MessageId,
});
export type ListActiveThreadWatchesByWatcherAndMessageInput =
  typeof ListActiveThreadWatchesByWatcherAndMessageInput.Type;

export const MarkThreadWatchGroupTriggeredInput = Schema.Struct({
  watcherThreadId: ThreadId,
  sourceMessageId: MessageId,
  triggeredAt: IsoDateTime,
});
export type MarkThreadWatchGroupTriggeredInput = typeof MarkThreadWatchGroupTriggeredInput.Type;

export const CancelActiveThreadWatchesForWatcherInput = Schema.Struct({
  watcherThreadId: ThreadId,
  cancelledAt: IsoDateTime,
});
export type CancelActiveThreadWatchesForWatcherInput =
  typeof CancelActiveThreadWatchesForWatcherInput.Type;

export interface ProjectionThreadWatchRepositoryShape {
  readonly replaceActiveWatchesForMessage: (
    input: ReplaceActiveThreadWatchesInput,
  ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
  readonly listActiveByWatchedThread: (
    input: ListActiveThreadWatchesByWatchedThreadInput,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionThreadWatch>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly listActiveByWatcherAndMessage: (
    input: ListActiveThreadWatchesByWatcherAndMessageInput,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionThreadWatch>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly listActiveByWatcher: (
    watcherThreadId: ThreadId,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionThreadWatch>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly markGroupTriggered: (
    input: MarkThreadWatchGroupTriggeredInput,
  ) => Effect.Effect<boolean, PersistenceSqlError | PersistenceDecodeError>;
  readonly cancelActiveForWatcher: (
    input: CancelActiveThreadWatchesForWatcherInput,
  ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
  readonly listAllActive: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadWatch>,
    PersistenceSqlError | PersistenceDecodeError
  >;
}

export class ProjectionThreadWatchRepository extends ServiceMap.Service<
  ProjectionThreadWatchRepository,
  ProjectionThreadWatchRepositoryShape
>()("t3/persistence/Services/ProjectionThreadWatches/ProjectionThreadWatchRepository") {}
