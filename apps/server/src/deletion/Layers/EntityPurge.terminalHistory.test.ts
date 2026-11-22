import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { dirname } from "node:path";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";
import { historyPath } from "../../terminal/Layers/Manager.history-io.ts";
import { TerminalManager, type TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { EntityPurge } from "../Services/EntityPurge.ts";
import { EntityPurgeLive } from "./EntityPurge.ts";

const NOW = "2026-11-22T00:00:00.000Z";
const held = { panes: new Set<string>(["held"]) as ReadonlySet<string> | "unknown" };
const fakeTerminal = Layer.succeed(TerminalManager, {
  retainedHistoryTerminalIds: () => Effect.sync(() => held.panes),
} as unknown as TerminalManagerShape);

const purgeLayer = (terminal: Layer.Layer<TerminalManager> | undefined, prefix: string) => {
  const base = EntityPurgeLive.pipe(
    Layer.provideMerge(
      Layer.succeed(OrchestrationProjectionPipeline, {
        bootstrap: Effect.void,
        backfillUsageContributions: Effect.void,
        ensureVerifiedBaselineThrough: () => Effect.void,
        compactVerifiedPrefix: () => Effect.void,
        projectEvent: () => Effect.void,
      }),
    ),
  );
  return (terminal ? base.pipe(Layer.provideMerge(terminal)) : base).pipe(
    Layer.provideMerge(CheckpointStoreLive.pipe(Layer.provide(GitCoreLive))),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
};

const seedPurgeableThread = Effect.fn("test.seedPurgeableThread")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const projectId = ProjectId.makeUnsafe(`project-${threadId}`);
  yield* sql`INSERT INTO projection_projects (project_id, title, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Project', '{}', ${NOW}, ${NOW})`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
      runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'Thread', '{"provider":"codex","model":"test"}',
      'full-access', 'default', ${NOW}, ${NOW})`;
  yield* sql`INSERT INTO projection_baselines (sequence, format_version, payload_json,
      payload_hash, verification_status, verification_detail, created_at, verified_at)
    VALUES (1, 1, '{}', 'test', 'verified', NULL, ${NOW}, ${NOW})
    ON CONFLICT (sequence) DO NOTHING`;
  yield* sql`INSERT INTO orchestration_deletion_markers (entity_kind, entity_id,
      deletion_sequence, deleted_at, covered_by_baseline_sequence)
    VALUES ('thread', ${threadId}, 1, ${NOW}, 1)`;
  const files = ["held", "plain"].map((pane) =>
    historyPath(config.terminalLogsDir, threadId, pane),
  );
  for (const file of files) {
    yield* fs.makeDirectory(dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "prompt$ ");
  }
  const exists = Effect.fn("test.historyExists")(function* () {
    return [yield* fs.exists(files[0]!), yield* fs.exists(files[1]!)];
  });
  return { exists };
});

const purgeStatus = Effect.fn("test.purgeStatus")(function* (jobId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly status: string }>`
    SELECT status FROM purge_jobs WHERE job_id = ${jobId}`;
  return rows[0]?.status;
});

it.layer(purgeLayer(fakeTerminal, "bigbud-purge-terminal-held-"))(
  "EntityPurge terminal history with a terminal manager (Q1, N8)",
  (it) => {
    it.effect("keeps a held pane's history and still completes the purge", () =>
      Effect.gen(function* () {
        held.panes = new Set(["held"]);
        const purge = yield* EntityPurge;
        const threadId = ThreadId.makeUnsafe("purge-held-history");
        const { exists } = yield* seedPurgeableThread(threadId);
        const job = yield* purge.requestThread(threadId);
        const claimed = job.resourceManifest.filter((r) => r.kind === "terminal-history");
        assert.equal(claimed.length, 1);
        yield* purge.run(job);
        assert.equal(yield* purgeStatus(job.jobId), "completed");
        assert.deepEqual(yield* exists(), [true, false]);
      }),
    );

    it.effect("an unreadable owner store claims no terminal history", () =>
      Effect.gen(function* () {
        held.panes = "unknown";
        const purge = yield* EntityPurge;
        const threadId = ThreadId.makeUnsafe("purge-unknown-history");
        const { exists } = yield* seedPurgeableThread(threadId);
        const job = yield* purge.requestThread(threadId);
        assert.isFalse(job.resourceManifest.some((r) => r.kind === "terminal-history"));
        yield* purge.run(job);
        assert.equal(yield* purgeStatus(job.jobId), "completed");
        assert.deepEqual(yield* exists(), [true, true]);
      }),
    );
  },
);

it.layer(purgeLayer(undefined, "bigbud-purge-terminal-none-"))(
  "EntityPurge terminal history without a terminal manager",
  (it) => {
    it.effect("treats every pane as held", () =>
      Effect.gen(function* () {
        const purge = yield* EntityPurge;
        const threadId = ThreadId.makeUnsafe("purge-no-terminal-manager");
        const { exists } = yield* seedPurgeableThread(threadId);
        const job = yield* purge.requestThread(threadId);
        yield* purge.run(job);
        assert.equal(yield* purgeStatus(job.jobId), "completed");
        assert.deepEqual(yield* exists(), [true, true]);
      }),
    );
  },
);
