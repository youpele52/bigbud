import { CommandId, ProjectId, ThreadId } from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";

import { ComputerUse } from "../../computer-use/Services/ComputerUse.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "../../persistence/Layers/ThreadRetentionRepository.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const oldAt = "2026-01-01T00:00:00.000Z";
const cutoffAt = "2026-02-01T00:00:00.000Z";
const changedAt = "2026-03-01T00:00:00.000Z";

const makeRuntime = () => {
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-retention-command-" });
  const engine = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.succeed(ComputerUse, { execute: () => Effect.die("unused"), dispose: Effect.void }),
    ),
    Layer.provideMerge(config),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  return ManagedRuntime.make(
    Layer.mergeAll(engine, ThreadRetentionRepositoryLive, ProjectionThreadRepositoryLive).pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
  );
};

it("claims in the command transaction, safely skips races, and deduplicates command IDs", async () => {
  const runtime = makeRuntime();
  try {
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      runtime.runPromise(effect as Effect.Effect<A, E, never>);
    const engine = await run(Effect.service(OrchestrationEngineService));
    const repository = await run(Effect.service(ThreadRetentionRepository));
    const projectId = ProjectId.makeUnsafe("retention-command-project");
    await run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("retention-project-create"),
        projectId,
        title: "Retention",
        workspaceRoot: "/tmp/retention-command",
        defaultModelSelection: { provider: "codex", model: "gpt-5.4" },
        createdAt: oldAt,
      }),
    );

    for (const threadId of ["retention-race", "retention-duplicate"]) {
      await run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`create-${threadId}`),
          threadId: ThreadId.makeUnsafe(threadId),
          projectId,
          title: threadId,
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: oldAt,
        }),
      );
    }

    await run(
      repository.createOrGetActiveRun({
        runId: "retention-command-run",
        trigger: "manual",
        policy: "30-days",
        cutoffAt,
        createdAt: changedAt,
      }),
    );
    await run(
      repository.insertSelectedItems({
        runId: "retention-command-run",
        candidates: [
          {
            threadId: ThreadId.makeUnsafe("retention-race"),
            lastActivityAt: oldAt,
            deletionCommandId: "retention-race-command",
          },
          {
            threadId: ThreadId.makeUnsafe("retention-duplicate"),
            lastActivityAt: oldAt,
            deletionCommandId: "retention-duplicate-command",
          },
        ],
        createdAt: changedAt,
      }),
    );
    const sql = await run(Effect.service(SqlClient.SqlClient));
    await run(
      sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('retention-race-user', 'retention-race', 'user', 'later', 0, ${changedAt}, ${changedAt})
      `,
    );

    const raceCommand = {
      type: "thread.retention-delete" as const,
      commandId: CommandId.makeUnsafe("retention-race-command"),
      threadId: ThreadId.makeUnsafe("retention-race"),
      runId: "retention-command-run",
      expectedLastActivityAt: oldAt,
      cutoffAt,
      createdAt: changedAt,
    };
    await run(engine.dispatch(raceCommand));
    assert.equal(
      Array.from(await run(Stream.runCollect(engine.readEvents(0)))).filter(
        (event) => event.commandId === raceCommand.commandId,
      ).length,
      0,
    );

    const duplicateCommand = {
      ...raceCommand,
      commandId: CommandId.makeUnsafe("retention-duplicate-command"),
      threadId: ThreadId.makeUnsafe("retention-duplicate"),
    };
    const first = await run(engine.dispatch(duplicateCommand));
    const second = await run(engine.dispatch(duplicateCommand));
    assert.equal(second.sequence, first.sequence);
    assert.equal(
      Array.from(await run(Stream.runCollect(engine.readEvents(0)))).filter(
        (event) =>
          event.commandId === duplicateCommand.commandId &&
          event.type === "thread.deletion-requested",
      ).length,
      1,
    );
    const lateSession = await run(
      Effect.exit(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("retention-late-session"),
          threadId: duplicateCommand.threadId,
          session: {
            threadId: duplicateCommand.threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: changedAt,
          },
          createdAt: changedAt,
        }),
      ),
    );
    assert.equal(lateSession._tag, "Failure");
  } finally {
    await runtime.dispose();
  }
});
