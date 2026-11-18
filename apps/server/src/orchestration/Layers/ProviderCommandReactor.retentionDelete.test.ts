import { CommandId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const threadId = ThreadId.makeUnsafe("thread-1");

/** Seeds an active retention run that selected `thread-1`, as `startThreadRetention` would. */
async function seedRetentionRun(
  harness: Harness,
  selectionMode: "per-thread" | "legacy-subtree",
): Promise<{ readonly runId: string; readonly commandId: string; readonly cutoffAt: string }> {
  const runId = `run-${selectionMode}`;
  const commandId = `server:thread-retention-delete:${runId}:${threadId}`;
  const cutoffAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const createdAt = new Date().toISOString();
  await Effect.runPromise(
    Effect.gen(function* () {
      const [thread] = yield* harness.sql<{ readonly createdAt: string }>`
        SELECT created_at AS "createdAt" FROM projection_threads WHERE thread_id = ${threadId}
      `;
      yield* harness.sql`INSERT INTO thread_retention_runs (
          run_id, trigger_kind, policy, selection_mode, age_criterion, cutoff_at, status,
          active_slot, eligible_count, created_at, updated_at
        ) VALUES (${runId}, 'manual', '1-day', ${selectionMode}, 'created', ${cutoffAt},
          'purging', 1, 1, ${createdAt}, ${createdAt})`;
      yield* harness.sql`INSERT INTO thread_retention_run_items (
          run_id, thread_id, expected_last_activity_at, deletion_command_id, status,
          created_at, updated_at
        ) VALUES (${runId}, ${threadId}, ${thread!.createdAt}, ${commandId}, 'selected',
          ${createdAt}, ${createdAt})`;
    }),
  );
  return { runId, commandId, cutoffAt };
}

async function dispatchRetentionDelete(
  harness: Harness,
  selectionMode: "per-thread" | "legacy-subtree",
) {
  const { runId, commandId, cutoffAt } = await seedRetentionRun(harness, selectionMode);
  const [item] = await Effect.runPromise(
    harness.sql<{ readonly expected: string }>`
      SELECT expected_last_activity_at AS expected FROM thread_retention_run_items
      WHERE run_id = ${runId}
    `,
  );
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.retention-delete",
      commandId: CommandId.makeUnsafe(commandId),
      threadId,
      runId,
      selectionMode,
      expectedLastActivityAt: item!.expected,
      cutoffAt,
      createdAt: new Date().toISOString(),
    }),
  );
}

const readThread = (harness: Harness) =>
  Effect.runPromise(
    harness.engine
      .getReadModel()
      .pipe(Effect.map((model) => model.threads.find((thread) => thread.id === threadId))),
  );

const isDeleted = async (harness: Harness) => {
  const thread = await readThread(harness);
  return thread === undefined || thread.deletedAt !== null;
};

const isFenceRoot = (harness: Harness) =>
  Effect.runPromise(harness.engine.threadDeletion!.isFenceRoot(threadId));

describe("ProviderCommandReactor retention deletes", () => {
  registerProviderCommandReactorTestCleanup();

  // D-3: a per-thread retention delete emitted `mode: "single"` while the engine held a
  // `subtree` fence, so the delete handler mistook its own fence for another subtree owner
  // and returned without deleting, aborting or releasing: the thread stayed `deleting`.
  it.each(["per-thread", "legacy-subtree"] as const)(
    "deletes a thread selected by a %s retention run and releases its fence",
    async (selectionMode) => {
      const harness = await createHarness();

      await dispatchRetentionDelete(harness, selectionMode);
      expect((await readThread(harness))?.deletingAt).not.toBeNull();

      await harness.drain();
      await waitFor(() => isDeleted(harness), 5_000);
      expect(await isFenceRoot(harness)).toBe(false);
    },
  );

  it("does not upgrade a direct delete's fence when per-thread retention finds it deleting", async () => {
    // Held open so the direct delete stays `deleting` while retention re-checks the thread.
    const harness = await createHarness({ startReactor: false });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-direct-delete"),
        threadId,
      }),
    );
    expect(
      await Effect.runPromise(harness.engine.threadDeletion!.isFenceRoot(threadId, "single")),
    ).toBe(true);

    await dispatchRetentionDelete(harness, "per-thread");
    expect(
      await Effect.runPromise(harness.engine.threadDeletion!.isFenceRoot(threadId, "single")),
    ).toBe(true);

    await harness.startReactor();
    await harness.drain();
    await waitFor(() => isDeleted(harness), 5_000);
    expect(await isFenceRoot(harness)).toBe(false);
  });
});
