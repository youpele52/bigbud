import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asProjectId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

const modelSelection = { provider: "codex", model: "gpt-5-codex" } as const;

describe("ProviderCommandReactor canonical thread deletion", () => {
  registerProviderCommandReactorTestCleanup();

  it("restores a replacement baseline across sparse deleted-thread gaps", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const rootThreadId = ThreadId.makeUnsafe("thread-1");
    const childThreadId = ThreadId.makeUnsafe("thread-delete-child");
    const retainedThreadId = ThreadId.makeUnsafe("thread-delete-retained");

    for (const [threadId, title, parentThread] of [
      [childThreadId, "Deleted child", rootThreadId],
      [retainedThreadId, "Retained thread", undefined],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`cmd-${threadId}-create`),
          threadId,
          projectId: asProjectId("project-1"),
          title,
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          ...(parentThread === undefined
            ? {}
            : {
                parentThread: {
                  threadId: parentThread,
                  projectId: asProjectId("project-1"),
                  title: "New thread",
                },
              }),
          createdAt: now,
        }),
      );
    }
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-canonical-delete"),
        threadId: rootThreadId,
      }),
    );
    await waitFor(async () => {
      const rows = await Effect.runPromise(
        harness.sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${rootThreadId}
        `,
      );
      return rows[0]?.count === 0;
    });

    const [retainedEvents, gaps, identities, deletedCanonical] = await Effect.runPromise(
      Effect.all([
        harness.sql<{ readonly threadId: string }>`
          SELECT stream_id AS "threadId" FROM orchestration_events
          WHERE aggregate_kind = 'thread' ORDER BY stream_id
        `,
        harness.sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_event_gaps`,
        harness.sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId" FROM orchestration_thread_identity ORDER BY thread_id
        `,
        harness.sql<{
          readonly receipts: number;
          readonly eventIds: number;
          readonly streamState: number;
          readonly markers: number;
        }>`
          SELECT
            (SELECT COUNT(*) FROM orchestration_command_receipts
              WHERE aggregate_kind = 'thread' AND aggregate_id IN (${rootThreadId}, ${childThreadId})) AS receipts,
            (SELECT COUNT(*) FROM orchestration_event_ids
              WHERE event_id IN (SELECT event_id FROM orchestration_event_gaps)) AS "eventIds",
            (SELECT COUNT(*) FROM orchestration_stream_state
              WHERE aggregate_kind = 'thread' AND stream_id IN (${rootThreadId}, ${childThreadId})) AS "streamState",
            (SELECT COUNT(*) FROM orchestration_deletion_markers
              WHERE entity_kind = 'thread' AND entity_id IN (${rootThreadId}, ${childThreadId})) AS markers
        `,
      ]),
    );
    expect(retainedEvents).toEqual([{ threadId: retainedThreadId }]);
    expect(gaps[0]?.count).toBeGreaterThan(0);
    expect(identities).toEqual([{ threadId: retainedThreadId }]);
    expect(deletedCanonical).toEqual([{ receipts: 0, eventIds: 0, streamState: 0, markers: 0 }]);

    await Effect.runPromise(
      harness.sql`DELETE FROM projection_threads`.pipe(
        Effect.andThen(harness.sql`DELETE FROM projection_state`),
        Effect.andThen(harness.projectionPipeline.bootstrap),
      ),
    );
    const restored = await Effect.runPromise(
      harness.sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM projection_threads ORDER BY thread_id
      `,
    );
    expect(restored).toEqual([{ threadId: retainedThreadId }]);
  });
});
