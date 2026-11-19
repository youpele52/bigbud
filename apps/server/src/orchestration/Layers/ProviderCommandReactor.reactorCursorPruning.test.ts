/**
 * Thread-deletion pruning vs. an open reactor replay cursor. A reactor that handles events
 * inline (here: a domain-event subscriber held on one event, exactly like ThreadWatchReactor or
 * ProviderTurnSupervisor when a handler is slow) must not have the deleted thread's canonical
 * events pruned above its cursor: its next replay page would be a gap and the stream would die.
 * Runs the real engine, ProviderCommandReactor deletion pipeline and SQLite event store.
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationEvent,
  ThreadId,
} from "@bigbud/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { finalizeThreadCanonicalHistoryWithCoverage } from "../../deletion/Layers/CanonicalThreadCleanup.ts";

import {
  asProjectId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

const modelSelection = { provider: "codex", model: "gpt-5-codex" } as const;
const deletedThreadId = ThreadId.makeUnsafe("thread-1");
const keeperThreadId = ThreadId.makeUnsafe("thread-cursor-keeper");

type Harness = Awaited<ReturnType<typeof createHarness>>;

const countThreadEvents = (harness: Harness, threadId: ThreadId) =>
  Effect.runPromise(
    harness.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
    `,
  ).then((rows) => rows[0]?.count ?? 0);

const countGaps = (harness: Harness) =>
  Effect.runPromise(
    harness.sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM orchestration_event_gaps`,
  ).then((rows) => rows[0]?.count ?? 0);

/** Whether a verified baseline covers the deleted thread's `thread.deleted` event. */
const baselineCoversDeletion = (harness: Harness) =>
  Effect.runPromise(
    harness.sql<{ readonly covered: number }>`
      SELECT EXISTS (
        SELECT 1 FROM projection_baselines AS baseline, orchestration_events AS deletion
        WHERE deletion.aggregate_kind = 'thread' AND deletion.stream_id = ${deletedThreadId}
          AND deletion.event_type = 'thread.deleted'
          AND baseline.verification_status = 'verified'
          AND baseline.sequence >= deletion.sequence
      ) AS covered
    `,
  ).then((rows) => rows[0]?.covered === 1);

type HeldReactor = Awaited<ReturnType<typeof startHeldReactor>>;

/** A domain-event subscriber that blocks on the first event it sees until released. */
async function startHeldReactor(harness: Harness) {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const holding = await Effect.runPromise(Deferred.make<void>());
  const seen: OrchestrationEvent[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(harness.engine.streamDomainEvents, (event) =>
      Effect.gen(function* () {
        seen.push(event);
        if (seen.length === 1) {
          yield* Deferred.succeed(holding, undefined);
          yield* Deferred.await(gate);
        }
      }),
    ),
  );
  // The held event: the subscriber reads it, advances its cursor to it, and blocks.
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("cmd-cursor-keeper-create"),
      threadId: keeperThreadId,
      projectId: asProjectId("project-1"),
      title: "Keeper",
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
    }),
  );
  await Effect.runPromise(Deferred.await(holding));
  return {
    seen,
    fiber,
    release: () => Effect.runPromise(Deferred.succeed(gate, undefined)),
  };
}

const deleteThread = (harness: Harness) =>
  Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.delete",
      commandId: CommandId.makeUnsafe("cmd-cursor-thread-delete"),
      threadId: deletedThreadId,
    }),
  );

const waitForDeletionCommitted = (harness: Harness) =>
  waitFor(async () => {
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((candidate) => candidate.id === deletedThreadId);
    return thread === undefined || thread.deletedAt !== null;
  }, 10_000);

const sawDeletion = (reactor: HeldReactor) =>
  reactor.seen.some(
    (event) => event.type === "thread.deleted" && event.aggregateId === deletedThreadId,
  );

/** Fails with the stream's cause when the held subscriber's stream has ended. */
function expectAlive(reactor: HeldReactor) {
  const exit = reactor.fiber.pollUnsafe();
  if (exit !== undefined && Exit.isFailure(exit)) {
    throw new Error(`held reactor stream ended: ${Cause.pretty(exit.cause)}`);
  }
  expect(exit).toBeUndefined();
}

async function releaseAndAwaitDeletion(reactor: HeldReactor) {
  await reactor.release();
  await waitFor(() => sawDeletion(reactor) || reactor.fiber.pollUnsafe() !== undefined, 5_000);
  expectAlive(reactor);
  expect(sawDeletion(reactor)).toBe(true);
}

describe("thread deletion pruning vs. reactor replay cursors", () => {
  registerProviderCommandReactorTestCleanup();

  it("defers pruning while a reactor is held behind the deletion, then recovery prunes", async () => {
    const harness = await createHarness();
    const reactor = await startHeldReactor(harness);
    await deleteThread(harness);
    await waitForDeletionCommitted(harness);
    // The pipeline waits for the held reactor, gives up, and leaves the pruning pending.
    await harness.drain();
    expect(await countThreadEvents(harness, deletedThreadId)).toBeGreaterThan(0);
    expect(await countGaps(harness)).toBe(0);

    await releaseAndAwaitDeletion(reactor);
    // Recovery's pruning step succeeds once every stream has read through the deletion.
    await Effect.runPromise(
      finalizeThreadCanonicalHistoryWithCoverage({ sql: harness.sql, threadId: deletedThreadId }),
    );
    expect(await countThreadEvents(harness, deletedThreadId)).toBe(0);
    expect(await countGaps(harness)).toBeGreaterThan(0);
    // The subscriber keeps consuming past the pruned range.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-cursor-keeper-rename"),
        threadId: keeperThreadId,
        title: "Keeper renamed",
      }),
    );
    await waitFor(() =>
      reactor.seen.some(
        (event) => event.type === "thread.meta-updated" && event.aggregateId === keeperThreadId,
      ),
    );
    expectAlive(reactor);
    await Effect.runPromise(Fiber.interrupt(reactor.fiber));
  });

  it("prunes in the deletion pipeline once a briefly held reactor catches up", async () => {
    const harness = await createHarness();
    const reactor = await startHeldReactor(harness);
    await deleteThread(harness);
    await waitForDeletionCommitted(harness);
    // Release only once the pipeline has verified its baseline, i.e. right before it prunes.
    await waitFor(() => baselineCoversDeletion(harness), 10_000);
    await releaseAndAwaitDeletion(reactor);
    await harness.drain();
    expect(await countThreadEvents(harness, deletedThreadId)).toBe(0);
    expectAlive(reactor);
    await Effect.runPromise(Fiber.interrupt(reactor.fiber));
  });
});
