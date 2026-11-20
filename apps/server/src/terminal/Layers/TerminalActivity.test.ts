import type { TerminalWorkActivity } from "@bigbud/contracts/workspace/terminal.activity.ts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { readOrganizationRawFacts } from "../../thread-organization/organizationFacts.query.ts";
import { installOrganizationOwner } from "../../thread-organization/organizationOwner.ts";
import { TerminalRecencyCoalescer } from "../activity/terminalRecencyCoalescer.ts";
import { TerminalViewRegistry } from "../activity/terminalViewRegistry.ts";
import { makeTerminalActivity } from "./TerminalActivity.ts";

const layer = it.layer(SqlitePersistenceMemory);
const MINUTE = 60_000;

const setup = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR IGNORE INTO projection_threads (
        thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at, archived_at, deleted_at
      ) VALUES (${threadId}, 'p', 't', 'standard', '{"provider":"codex","model":"m"}',
        'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL)`;
    let now = Date.parse("2026-02-01T00:00:00.000Z");
    const views = new TerminalViewRegistry();
    const items: TerminalWorkActivity[] = [];
    const observed: string[] = [];
    installOrganizationOwner(sql, {
      backendNonce: "n",
      generation: 1,
      active: true,
      observedAtMs: 0,
      policy: {} as never,
      idleNotBeforeMs: 0,
      rows: new Map(),
      observe: (ids) => observed.push(...ids),
    });
    const activity = yield* makeTerminalActivity({
      views,
      now: () => now,
      coalescer: new TerminalRecencyCoalescer(MINUTE),
    });
    yield* activity.subscribe((item) => Effect.sync(() => items.push(item)));
    const recency = () =>
      sql<{ at: string | null }>`SELECT latest_terminal_activity_at AS at FROM projection_threads
        WHERE thread_id = ${threadId}`.pipe(Effect.map((rows) => rows[0]?.at ?? null));
    const facts = () =>
      readOrganizationRawFacts(sql, threadId).pipe(Effect.map((rows) => rows[0]!));
    return {
      activity,
      views,
      items,
      observed,
      recency,
      facts,
      advance: (ms: number) => (now += ms),
      at: () => now,
    };
  });

const finishedCommand = (atMs: number, durationMs: number, exitCode = 1) => ({
  atMs,
  command: "npm test",
  exitCode,
  durationMs,
  source: "shell-integration" as const,
});

layer("TerminalActivity", (it) => {
  it.effect("persists Enter recency at once, then at most once per minute", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* setup("ta-recency");
        yield* t.activity.submit("ta-recency", "default", t.at());
        assert.equal(yield* t.recency(), "2026-02-01T00:00:00.000Z");
        t.advance(10_000);
        yield* t.activity.submit("ta-recency", "default", t.at());
        assert.equal(yield* t.recency(), "2026-02-01T00:00:00.000Z");
        assert.equal(t.items.filter((item) => item.latestActivityAt).length, 1);
      }),
    ),
  );

  it.effect("raises a long finished command as an organiser attention fact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* setup("ta-raise");
        yield* t.activity.finished("ta-raise", "default", finishedCommand(t.at(), 70_000));
        const facts = yield* t.facts();
        assert.equal(facts.actionable, 1);
        assert.deepEqual(JSON.parse(facts.attentionIdsJson), [
          "terminal-finished:default:2026-02-01T00:00:00.000Z",
        ]);
        assert.deepEqual(t.observed, ["ta-raise"]);
        const raised = t.items.find((item) => item.finished);
        assert.equal(raised?.finished?.command, "npm test");
        assert.equal(raised?.finished?.exitCode, 1);
        assert.equal(yield* t.recency(), "2026-02-01T00:00:00.000Z");
      }),
    ),
  );

  it.effect("skips short commands, Ctrl-C stops and viewed panes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* setup("ta-skip");
        yield* t.activity.finished("ta-skip", "default", finishedCommand(t.at(), 30_000));
        yield* t.activity.finished("ta-skip", "default", finishedCommand(t.at(), 90_000, 130));
        t.views.update(
          "client",
          { threadId: "ta-skip" as never, terminalIds: ["default"] },
          t.at(),
        );
        yield* t.activity.finished("ta-skip", "default", finishedCommand(t.at(), 90_000));
        assert.equal((yield* t.facts()).actionable, 0);
        assert.deepEqual(t.items, []);
      }),
    ),
  );

  it.effect("clears on Enter in the pane, on viewing it, and on opening the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* setup("ta-clear");
        const raise = (terminalId: string) =>
          t.activity.finished("ta-clear", terminalId, finishedCommand(t.at(), 70_000));
        yield* raise("a");
        yield* raise("b");
        yield* t.activity.submit("ta-clear", "a", t.at());
        assert.deepEqual(JSON.parse((yield* t.facts()).attentionIdsJson).length, 1);
        yield* t.activity.view("client", { threadId: "ta-clear" as never, terminalIds: ["b"] });
        assert.equal((yield* t.facts()).actionable, 0);
        yield* t.activity.view("client", { threadId: null, terminalIds: [] });
        yield* raise("c");
        assert.equal((yield* t.facts()).actionable, 1);
        yield* t.activity.view("client", { threadId: "ta-clear" as never, terminalIds: [] });
        assert.equal((yield* t.facts()).actionable, 0);
        const cleared = t.items.filter((item) => item.finished === null).map((i) => i.terminalId);
        assert.deepEqual(cleared, ["a", "b", "c"]);
      }),
    ),
  );

  it.effect("keeps raised items across a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* setup("ta-restart");
        yield* t.activity.finished("ta-restart", "default", {
          atMs: t.at(),
          exitCode: null,
          durationMs: null,
          source: "agent-hook",
        });
        const restarted = yield* makeTerminalActivity({ views: new TerminalViewRegistry() });
        assert.equal((yield* t.facts()).actionable, 1);
        yield* restarted.submit("ta-restart", "default", t.at());
        assert.equal((yield* t.facts()).actionable, 0);
      }),
    ),
  );
});
