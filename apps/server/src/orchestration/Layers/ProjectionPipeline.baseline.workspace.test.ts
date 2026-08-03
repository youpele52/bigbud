import { CommandId, EventId, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path, Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionBaselineRepository } from "../../persistence/Services/ProjectionBaselines.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../startup/config.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { BaseTestLayer } from "./ProjectionPipeline.test.helpers.ts";

it.layer(BaseTestLayer)("projection baseline workspace", (it) => {
  it.effect("recreates a file-backed workspace whose current ledger misses a required table", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const workspacePath = path.join(
        config.stateDir,
        "projection-baseline-verification",
        "1.sqlite",
      );
      const corruptScope = yield* Scope.make("sequential");
      const corruptContext = yield* Layer.build(makeSqlitePersistenceLive(workspacePath)).pipe(
        Scope.provide(corruptScope),
      );
      const corruptSql = yield* Effect.service(SqlClient.SqlClient).pipe(
        Effect.provide(corruptContext),
      );
      const usageTable = yield* corruptSql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_usage_contributions'
      `;
      assert.deepEqual(usageTable, [{ name: "projection_usage_contributions" }]);
      yield* corruptSql`DROP TABLE projection_usage_contributions`;
      yield* Scope.close(corruptScope, Exit.void);

      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const now = "2026-08-03T00:00:00.000Z";
      const projectId = ProjectId.makeUnsafe("workspace-recovery-project");
      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("workspace-recovery-event"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("workspace-recovery-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: "Recovery project",
          workspaceRoot: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* pipeline.bootstrap;
      yield* pipeline.ensureVerifiedBaselineThrough(1);

      const baselines = yield* ProjectionBaselineRepository;
      const verified = yield* baselines.latestVerified();
      assert.equal(verified._tag, "Some");
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        assert.isFalse(yield* fs.exists(`${workspacePath}${suffix}`));
      }
    }),
  );
});
