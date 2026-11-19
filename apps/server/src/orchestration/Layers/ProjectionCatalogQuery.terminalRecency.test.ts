import { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";
import { threadSummarySortKey } from "./ProjectionCatalogQuery.threadPages.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const projectId = ProjectId.makeUnsafe("recency-project");

const insertThread = (id: string, createdAt: string, terminalAt: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR IGNORE INTO projection_threads (
        thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at, archived_at, deleted_at, organization_state,
        latest_terminal_activity_at
      ) VALUES (
        ${id}, ${projectId}, ${id}, 'standard', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', ${createdAt}, ${createdAt}, NULL, NULL, 'present', ${terminalAt}
      )
    `;
  });

const userMessage = (threadId: string, at: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR IGNORE INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (${`${threadId}-user`}, ${threadId}, 'user', 'hi', 0, ${at}, ${at})
    `;
  });

const seed = Effect.gen(function* () {
  // chat-only: a message on day 5; terminal-only: Enter on day 7; mixed: message day 3,
  // terminal day 6; untouched: created day 4.
  yield* insertThread("r-chat", "2026-01-01T00:00:00.000Z", null);
  yield* userMessage("r-chat", "2026-01-05T00:00:00.000Z");
  yield* insertThread("r-terminal", "2026-01-01T00:00:00.000Z", "2026-01-07T00:00:00.000Z");
  yield* insertThread("r-mixed", "2026-01-01T00:00:00.000Z", "2026-01-06T00:00:00.000Z");
  yield* userMessage("r-mixed", "2026-01-03T00:00:00.000Z");
  yield* insertThread("r-new", "2026-01-04T00:00:00.000Z", null);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR REPLACE INTO terminal_finished_attention
    (thread_id, terminal_id, finished_at, command, exit_code, duration_ms, source)
    VALUES ('r-terminal', 'default', '2026-01-07T00:00:00.000Z', 'npm test', 1, 70000,
      'shell-integration'),
      ('r-terminal', 'two', '2026-01-07T00:01:00.000Z', NULL, NULL, NULL, 'agent-hook')`;
});

const expectedOrder = ["r-terminal", "r-mixed", "r-chat", "r-new"];

layer("ProjectionCatalogQuery terminal recency", (it) => {
  it.effect("pages project threads by the later of message and terminal activity", () =>
    Effect.gen(function* () {
      yield* seed;
      const query = yield* ProjectionCatalogQuery;
      const ids: string[] = [];
      let cursor: Parameters<typeof query.getProjectThreadSummaries>[0]["cursor"];
      do {
        const page = yield* query.getProjectThreadSummaries({
          projectId,
          limit: 1,
          sortOrder: "updated_at",
          ...(cursor ? { cursor } : {}),
        });
        ids.push(...page.threads.map((thread) => thread.id));
        cursor = page.nextCursor;
      } while (cursor && ids.length < 10);
      assert.deepEqual(ids, expectedOrder);
    }),
  );

  it.effect("pages an Inyosira state by the same key and carries terminal fields", () =>
    Effect.gen(function* () {
      yield* seed;
      const query = yield* ProjectionCatalogQuery;
      const page = yield* query.getOrganizationThreadSummaries({ state: "present", limit: 10 });
      assert.deepEqual(
        page.threads.map((thread) => thread.id),
        expectedOrder,
      );
      const terminal = page.threads[0]!;
      assert.equal(terminal.latestTerminalActivityAt, "2026-01-07T00:00:00.000Z");
      assert.deepEqual(
        terminal.terminalFinished?.toSorted((a, b) => a.terminalId.localeCompare(b.terminalId)),
        [
          {
            terminalId: "default",
            finishedAt: "2026-01-07T00:00:00.000Z",
            command: "npm test",
            exitCode: 1,
            durationMs: 70000,
            source: "shell-integration",
          },
          {
            terminalId: "two",
            finishedAt: "2026-01-07T00:01:00.000Z",
            exitCode: null,
            durationMs: null,
            source: "agent-hook",
          },
        ],
      );
      assert.deepEqual(page.threads[2]!.terminalFinished, []);
    }),
  );

  it("computes the cursor sort key as the later of both times", () => {
    const base = { createdAt: "2026-01-01T00:00:00.000Z" };
    assert.equal(
      threadSummarySortKey(
        {
          ...base,
          latestUserMessageAt: "2026-01-03T00:00:00.000Z",
          latestTerminalActivityAt: "2026-01-06T00:00:00.000Z",
        },
        "updated_at",
      ),
      "2026-01-06T00:00:00.000Z",
    );
    assert.equal(
      threadSummarySortKey(
        {
          ...base,
          latestUserMessageAt: "2026-01-05T00:00:00.000Z",
          latestTerminalActivityAt: null,
        },
        "updated_at",
      ),
      "2026-01-05T00:00:00.000Z",
    );
    assert.equal(
      threadSummarySortKey(
        {
          ...base,
          latestUserMessageAt: null,
          latestTerminalActivityAt: "2026-01-06T00:00:00.000Z",
        },
        "created_at",
      ),
      base.createdAt,
    );
  });
});
