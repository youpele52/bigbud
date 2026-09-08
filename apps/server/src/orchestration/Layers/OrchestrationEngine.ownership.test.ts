import { ProjectId, ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { it } from "@effect/vitest";
import { Effect, Option, Semaphore } from "effect";
import { expect, vi } from "vitest";

import { createEmptyReadModel } from "../projectorReadModel.ts";
import { makeThreadOwnershipResolver } from "./OrchestrationEngine.ownership.ts";

const projectId = ProjectId.makeUnsafe("project-canonical-owner");
const threadId = ThreadId.makeUnsafe("thread-canonical-owner");

it.effect("never reports absent when canonical identity outlives its projection", () =>
  Effect.gen(function* () {
    const commandSemaphore = yield* Semaphore.make(1);
    const hydrate = vi.fn(() => Effect.sync(() => undefined));
    const readModel = {
      ...createEmptyReadModel("2026-08-26T00:00:00.000Z"),
      snapshotSequence: 41,
    };
    const resolve = makeThreadOwnershipResolver({
      serverEpoch: "server-epoch-1",
      commandSemaphore,
      eventStore: {
        findThreadOwnershipEvidence: () =>
          Effect.succeed(
            Option.some({
              projectId,
              latestCreatedSequence: 10,
              deletionSequence: null,
              deletedAt: null,
            }),
          ),
      },
      readModel: () => readModel,
      hydrate,
    });

    expect(yield* resolve(threadId)).toEqual({
      threadId,
      projectId,
      status: "unavailable",
      ownership: "confirmed",
      reason: "Canonical ownership is confirmed, but lifecycle state is unavailable.",
      serverEpoch: "server-epoch-1",
      canonicalRevision: 41,
    });
    expect(hydrate).toHaveBeenCalledWith(threadId);
  }),
);

it.effect("reports deleted lifecycle with the current explicit-create reuse policy", () =>
  Effect.gen(function* () {
    const commandSemaphore = yield* Semaphore.make(1);
    const deletedThread = {
      id: threadId,
      projectId,
      archivedAt: null,
      deletingAt: null,
      deletedAt: "2026-08-26T10:02:35.000Z",
    } as unknown as OrchestrationThread;
    const resolve = makeThreadOwnershipResolver({
      serverEpoch: "server-epoch-deleted",
      commandSemaphore,
      eventStore: {
        findThreadOwnershipEvidence: () =>
          Effect.succeed(
            Option.some({
              projectId,
              latestCreatedSequence: 10,
              deletionSequence: 43,
              deletedAt: "2026-08-26T10:02:35.000Z",
            }),
          ),
      },
      readModel: () => ({
        ...createEmptyReadModel("2026-08-26T00:00:00.000Z"),
        snapshotSequence: 43,
        threads: [deletedThread],
      }),
      hydrate: null,
    });

    expect(yield* resolve(threadId)).toEqual({
      threadId,
      projectId,
      status: "deleted",
      reusePolicy: "explicit-create-after-deletion",
      serverEpoch: "server-epoch-deleted",
      canonicalRevision: 43,
    });
  }),
);

it.effect("reports canonical deletion after lifecycle state is no longer hydratable", () =>
  Effect.gen(function* () {
    const commandSemaphore = yield* Semaphore.make(1);
    const resolve = makeThreadOwnershipResolver({
      serverEpoch: "server-epoch-deletion-marker",
      commandSemaphore,
      eventStore: {
        findThreadOwnershipEvidence: () =>
          Effect.succeed(
            Option.some({
              projectId,
              latestCreatedSequence: 10,
              deletionSequence: 44,
              deletedAt: "2026-08-26T10:02:35.000Z",
            }),
          ),
      },
      readModel: () => ({
        ...createEmptyReadModel("2026-08-26T00:00:00.000Z"),
        snapshotSequence: 41,
      }),
      hydrate: () => Effect.sync(() => undefined),
    });

    expect(yield* resolve(threadId)).toEqual({
      threadId,
      projectId,
      status: "deleted",
      reusePolicy: "explicit-create-after-deletion",
      serverEpoch: "server-epoch-deletion-marker",
      canonicalRevision: 44,
    });
  }),
);

it.effect("does not report an old deletion marker after an allowed recreate", () =>
  Effect.gen(function* () {
    const commandSemaphore = yield* Semaphore.make(1);
    const resolve = makeThreadOwnershipResolver({
      serverEpoch: "server-epoch-recreated",
      commandSemaphore,
      eventStore: {
        findThreadOwnershipEvidence: () =>
          Effect.succeed(
            Option.some({
              projectId,
              latestCreatedSequence: 45,
              deletionSequence: 44,
              deletedAt: "2026-08-26T10:02:35.000Z",
            }),
          ),
      },
      readModel: () => ({
        ...createEmptyReadModel("2026-08-26T00:00:00.000Z"),
        snapshotSequence: 45,
      }),
      hydrate: () => Effect.sync(() => undefined),
    });

    expect(yield* resolve(threadId)).toMatchObject({
      threadId,
      projectId,
      status: "unavailable",
      ownership: "confirmed",
    });
  }),
);

it.effect("confirms absence only when canonical identity is absent", () =>
  Effect.gen(function* () {
    const commandSemaphore = yield* Semaphore.make(1);
    const resolve = makeThreadOwnershipResolver({
      serverEpoch: "server-epoch-2",
      commandSemaphore,
      eventStore: { findThreadOwnershipEvidence: () => Effect.succeed(Option.none()) },
      readModel: () => ({
        ...createEmptyReadModel("2026-08-26T00:00:00.000Z"),
        snapshotSequence: 42,
      }),
      hydrate: null,
    });

    expect(yield* resolve(threadId)).toEqual({
      threadId,
      status: "absent",
      serverEpoch: "server-epoch-2",
      canonicalRevision: 42,
      reusePolicy: "canonical-identity-unclaimed",
    });
  }),
);

it.effect("blocks materialization for marker-only legacy deletion evidence", () =>
  Effect.gen(function* () {
    const commandSemaphore = yield* Semaphore.make(1);
    const resolve = makeThreadOwnershipResolver({
      serverEpoch: "server-epoch-marker-only",
      commandSemaphore,
      eventStore: {
        findThreadOwnershipEvidence: () =>
          Effect.succeed(
            Option.some({
              projectId: null,
              latestCreatedSequence: null,
              deletionSequence: 46,
              deletedAt: "2026-08-26T10:02:35.000Z",
            }),
          ),
      },
      readModel: () => ({
        ...createEmptyReadModel("2026-08-26T00:00:00.000Z"),
        snapshotSequence: 45,
      }),
      hydrate: () => Effect.sync(() => undefined),
    });

    expect(yield* resolve(threadId)).toEqual({
      threadId,
      status: "unavailable",
      ownership: "confirmed",
      reason: "Canonical deletion is confirmed, but project ownership is unavailable.",
      serverEpoch: "server-epoch-marker-only",
      canonicalRevision: 46,
    });
  }),
);
