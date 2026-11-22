import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { cleanupDeletedThreadTerminalHistory } from "../../orchestration/Layers/ProviderCommandReactorHandlers.delete.cleanup.ts";
import { terminalManagerRetainedHistory } from "./TerminalHistoryRetention.ts";
import { fixture, owner } from "../../persistence/Layers/DirectShellLaunchOwners.test.helpers.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import { ServerConfig } from "../../startup/config.ts";
import { directShellOwnerKey } from "../../terminal/Layers/DirectShellLaunch.owner.ts";
import { historyPath } from "../../terminal/Layers/Manager.history-io.ts";
import {
  FakeHostAdapter,
  makeHostManager,
} from "../../terminal/Layers/Manager.host.test.helpers.ts";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import {
  ThreadDeletion,
  ThreadDeletionLive,
  toThreadDeletionOperationError,
} from "../Services/ThreadDeletion.ts";

const layer = it.layer(
  Layer.mergeAll(
    SqlitePersistenceMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "thread-deletion-logs-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    NodeServices.layer,
  ),
  { excludeTestServices: true },
);
const now = "2026-11-22T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("thread-44444444-4444-4444-8444-444444444444");
const thread = { id: threadId, projectId: "project", deletedAt: null } as OrchestrationThread;

const setup = Effect.fn("test.setupThreadDeletionLogs")(function* (
  options: { readonly guarded?: boolean } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* sql`INSERT OR IGNORE INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Project', '/project', '[]', ${now}, ${now})`;
  yield* sql`INSERT OR IGNORE INTO projection_threads
    (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      created_at, updated_at)
    VALUES (${threadId}, 'project', 'Thread', '{"provider":"codex","model":"test"}',
      'full-access', 'default', ${now}, ${now})`;
  const db = yield* Effect.promise(fixture);
  if (options.guarded) {
    const pane = { threadId, terminalId: "ssh-pane" };
    yield* Effect.promise(() =>
      db.store.reserve({
        ...owner(),
        ownerKey: directShellOwnerKey(pane.threadId, pane.terminalId),
        pane,
      }),
    );
  }
  const adapter = new FakeHostAdapter();
  const { manager } = yield* makeHostManager(adapter, {
    logsDir: config.terminalLogsDir,
    directShellOwners: db.store,
  });
  const history = (terminalId: string) => historyPath(config.terminalLogsDir, threadId, terminalId);
  const panes = ["ssh-pane", "host-pane", "plain"];
  for (const terminalId of panes) {
    yield* fs.makeDirectory(dirname(history(terminalId)), { recursive: true });
    yield* fs.writeFileString(history(terminalId), "prompt$ ");
  }
  const surviving = Effect.fn("test.survivingHistory")(function* () {
    const kept: Array<string> = [];
    for (const terminalId of panes)
      if (yield* fs.exists(history(terminalId))) kept.push(terminalId);
    return kept;
  });
  return { adapter, manager, history, surviving };
});

/** A non-terminal row in the host owner table: the host may still run the pane's PTY. */
function liveHostRow(adapter: FakeHostAdapter, terminalId: string) {
  const ownerKey = `terminal:${JSON.stringify([threadId, terminalId])}`;
  adapter.ownership.rows.set(ownerKey, {
    ...profileOwner(),
    ownerKey,
    target: "local-terminal-host",
    resourceId: `pty-${terminalId}`,
    state: "may-have-been-sent",
  });
}

/** The production order: teardown (guarded close), discovery, removal, post-commit close. */
const deleteThread = Effect.fn("test.deleteThread")(function* (manager: TerminalManagerShape) {
  const deletion = yield* Effect.service(ThreadDeletion).pipe(Effect.provide(ThreadDeletionLive));
  const deleted: Array<string> = [];
  const outcome = yield* deletion.deleteNow({
    rootThreadId: threadId,
    resolveThreads: () => Effect.succeed([thread]),
    preflight: () => Effect.void,
    teardown: (candidate) =>
      manager
        .close({ threadId: candidate.id, deleteHistory: false })
        .pipe(Effect.mapError(toThreadDeletionOperationError)),
    finalize: (threadIds) =>
      Effect.gen(function* () {
        const files = yield* deletion.discoverFiles({
          rootThreadId: threadId,
          threadIds,
          retainedTerminalHistory: terminalManagerRetainedHistory(manager),
        });
        for (const resource of files.directResources) {
          deleted.push(resource.relativePath);
          yield* Effect.promise(() => rm(join(resource.root, resource.relativePath)));
        }
        yield* cleanupDeletedThreadTerminalHistory(manager, threadId, threadIds);
      }),
  });
  return { outcome, deleted };
});

layer("thread deletion terminal history (Q1, N8)", (it) => {
  it.effect("a guard that blocks the deletion leaves every history file in place", () =>
    Effect.gen(function* () {
      const { manager, surviving } = yield* setup({ guarded: true });
      const { outcome, deleted } = yield* deleteThread(manager);
      assert.equal(outcome.type, "failed");
      assert.deepEqual(deleted, []);
      assert.deepEqual(yield* surviving(), ["ssh-pane", "host-pane", "plain"]);

      // Discovery itself never captures the file of a pane the guard still matches.
      const deletion = yield* Effect.service(ThreadDeletion).pipe(
        Effect.provide(ThreadDeletionLive),
      );
      const files = yield* deletion.discoverFiles({
        rootThreadId: threadId,
        threadIds: [threadId],
        retainedTerminalHistory: terminalManagerRetainedHistory(manager),
      });
      const captured = files.directResources.map((resource) => resource.relativePath);
      assert.equal(captured.length, 2);
      assert.notInclude(captured, historyPathName(threadId, "ssh-pane"));
    }),
  );

  it.effect("a deletion with every owner released removes all of the thread's history", () =>
    Effect.gen(function* () {
      const { manager, surviving } = yield* setup();
      const { outcome, deleted } = yield* deleteThread(manager);
      assert.equal(outcome.type, "deleted");
      assert.equal(deleted.length, 3);
      assert.deepEqual(yield* surviving(), []);
    }),
  );

  it.effect("discovery keeps the history of a pane the host may still run", () =>
    Effect.gen(function* () {
      const { adapter, manager } = yield* setup();
      liveHostRow(adapter, "host-pane");
      const deletion = yield* Effect.service(ThreadDeletion).pipe(
        Effect.provide(ThreadDeletionLive),
      );
      const files = yield* deletion.discoverFiles({
        rootThreadId: threadId,
        threadIds: [threadId],
        retainedTerminalHistory: terminalManagerRetainedHistory(manager),
      });
      assert.deepEqual(
        files.directResources.map((resource) => resource.relativePath).toSorted(),
        [historyPathName(threadId, "ssh-pane"), historyPathName(threadId, "plain")].toSorted(),
      );
    }),
  );

  it.effect("an unreadable owner store deletes no terminal history", () =>
    Effect.gen(function* () {
      const { adapter, manager, surviving } = yield* setup();
      Object.assign(adapter.ownership.store, {
        listTerminalOwners: async () => {
          throw new Error("database locked");
        },
      });
      const { outcome, deleted } = yield* deleteThread(manager);
      assert.equal(outcome.type, "deleted");
      assert.deepEqual(deleted, []);
      assert.deepEqual(yield* surviving(), ["ssh-pane", "host-pane", "plain"]);
    }),
  );
});

function historyPathName(id: string, terminalId: string): string {
  return historyPath("", id, terminalId);
}
