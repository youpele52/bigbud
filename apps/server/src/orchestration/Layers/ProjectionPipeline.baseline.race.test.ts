import { CommandId, ProjectId, ThreadId } from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ComputerUse } from "../../computer-use/Services/ComputerUse.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionBaselineRepositoryLive } from "../../persistence/Layers/ProjectionBaselines.ts";
import { insertCapturedBaseline } from "../../persistence/Layers/ProjectionBaselines.test.helpers.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { emptyBaselinePayloadSource } from "../../persistence/ProjectionBaselineRows.ts";
import {
  ProjectionBaselineRepository,
  type ProjectionBaseline,
  type ProjectionBaselineRepositoryShape,
} from "../../persistence/Services/ProjectionBaselines.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { makeProjectionBaselineCoordinator } from "./ProjectionPipeline.baseline.coordination.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const at = "2026-11-18T00:00:00.000Z";
const modelSelection = { provider: "codex", model: "gpt-5.4" } as const;

const makeRuntime = () =>
  ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(
        Layer.succeed(ComputerUse, { execute: () => Effect.die("unused"), dispose: Effect.void }),
      ),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-baseline-race-" }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

it("covers a project cascade when verify-only and compacting baseline requests overlap", async () => {
  const runtime = makeRuntime();
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    runtime.runPromise(effect as Effect.Effect<A, E, never>);
  try {
    const engine = await run(Effect.service(OrchestrationEngineService));
    const pipeline = await run(Effect.service(OrchestrationProjectionPipeline));
    const sql = await run(Effect.service(SqlClient.SqlClient));
    const verifyOnly = pipeline.ensureVerifiedBaselineThroughWithoutCompaction!;
    const projectId = ProjectId.makeUnsafe("race-project");
    await run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("race-project-create"),
        projectId,
        title: "Race",
        workspaceRoot: "/tmp/bigbud-baseline-race",
        defaultModelSelection: modelSelection,
        createdAt: at,
      }),
    );
    const createThread = (id: string, parent?: string) =>
      run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`race-create-${id}`),
          threadId: ThreadId.makeUnsafe(id),
          projectId,
          title: id,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          ...(parent
            ? { parentThread: { threadId: ThreadId.makeUnsafe(parent), projectId, title: parent } }
            : {}),
          createdAt: at,
        }),
      );
    await createThread("race-root");
    await createThread("race-child", "race-root");
    await createThread("race-sibling");
    await run(
      engine.dispatch({
        type: "project.delete",
        commandId: CommandId.makeUnsafe("race-project-delete"),
        projectId,
      }),
    );
    const finalizeThread = (id: string, threadIds: ReadonlyArray<string>) =>
      run(
        engine.dispatch({
          type: "thread.delete.finalize",
          commandId: CommandId.makeUnsafe(`race-finalize-${id}`),
          threadId: ThreadId.makeUnsafe(id),
          threadIds: threadIds.map((threadId) => ThreadId.makeUnsafe(threadId)),
          mode: "subtree",
          origin: "project-cascade",
          createdAt: at,
        }),
      );
    const root = await finalizeThread("race-root", ["race-root", "race-child"]);

    // The cascade's canonical cleanup (verify-only) and a purge preflight (compacting) ask for
    // the same coverage at once. Before the fix they verified one candidate in one workspace:
    // one of them failed, and its coordinator replayed that failure for the whole cooldown.
    const overlapping = await run(
      Effect.all(
        [
          Effect.exit(verifyOnly(root.sequence)),
          Effect.exit(pipeline.ensureVerifiedBaselineThrough(root.sequence)),
        ],
        { concurrency: "unbounded" },
      ),
    );
    assert.deepEqual(
      overlapping.map((exit) => exit._tag),
      ["Success", "Success"],
    );

    const sibling = await finalizeThread("race-sibling", ["race-sibling"]);
    await run(verifyOnly(sibling.sequence));
    const project = await run(
      engine.dispatch({
        type: "project.delete.finalize",
        commandId: CommandId.makeUnsafe("race-project-finalize"),
        projectId,
        createdAt: at,
      }),
    );
    await run(verifyOnly(project.sequence));

    const baselines = await run(sql<{ readonly sequence: number; readonly status: string }>`
      SELECT sequence, verification_status AS status FROM projection_baselines
    `);
    assert.deepEqual(baselines, [{ sequence: project.sequence, status: "verified" }]);
    const uncovered = await run(sql<{ readonly entityId: string }>`
      SELECT entity_id AS "entityId" FROM orchestration_deletion_markers
      WHERE covered_by_baseline_sequence IS NULL OR covered_by_baseline_sequence < deletion_sequence
    `);
    assert.deepEqual(uncovered, []);
  } finally {
    await runtime.dispose();
  }
});

const baselineAt = (sequence: number): ProjectionBaseline => ({
  baselineId: sequence,
  sequence,
  formatVersion: 2,
  payloadHash: `hash-${sequence}`,
  verificationStatus: "verified",
  verificationDetail: null,
  createdAt: at,
  verifiedAt: at,
});

const sequenceOnlyBaselines = (
  latest: () => Option.Option<number>,
): ProjectionBaselineRepositoryShape => ({
  captureDigest: () => Effect.succeed("digest"),
  createCandidate: () => Effect.succeed(Option.none()),
  getById: () => Effect.succeed(Option.none()),
  latestVerified: () => Effect.succeed(Option.map(latest(), baselineAt)),
  latestVerifiedSequence: () => Effect.succeed(latest()),
  markRejected: () => Effect.void,
  markVerified: () => Effect.void,
  payloadSource: () => emptyBaselinePayloadSource,
  restorePayload: () => Effect.void,
});

it.effect("does not replay a cooled-down failure once a verified baseline covers the request", () =>
  Effect.gen(function* () {
    let verified = Option.none<number>();
    let compactCount = 0;
    const ensure = yield* makeProjectionBaselineCoordinator({
      baselines: sequenceOnlyBaselines(() => verified),
      compact: Effect.sync(() => {
        compactCount += 1;
      }),
    });

    // No candidate yet: the request fails and the failure starts the cooldown.
    assert.equal((yield* Effect.exit(ensure(10)))._tag, "Failure");
    // Still uncovered: the cooldown holds and verification is not retried.
    assert.equal((yield* Effect.exit(ensure(16)))._tag, "Failure");
    assert.equal(compactCount, 1);

    // Another flight verifies through 16 inside the cooldown window.
    verified = Option.some(16);
    yield* ensure(10);
    yield* ensure(16);
    assert.equal(compactCount, 1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.layer(ProjectionBaselineRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "projection baseline finalization",
  (it) => {
    it.effect("never records coverage for a candidate that was rejected meanwhile", () =>
      Effect.gen(function* () {
        const baselines = yield* ProjectionBaselineRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO orchestration_deletion_markers (
            entity_kind, entity_id, deletion_sequence, deleted_at
          ) VALUES ('thread', 'rejected-meanwhile', 3, ${at})
        `;
        const { baselineId } = yield* insertCapturedBaseline({
          sequence: 3,
          status: "candidate",
          createdAt: at,
        });
        yield* baselines.markRejected(baselineId, "concurrent verification failure");

        const marked = yield* Effect.exit(baselines.markVerified(baselineId, 3, at));
        assert.isTrue(Exit.isFailure(marked));
        const markers = yield* sql<{ readonly covered: number | null }>`
          SELECT covered_by_baseline_sequence AS covered FROM orchestration_deletion_markers
        `;
        assert.deepEqual(markers, [{ covered: null }]);
        const retention = yield* sql<{ readonly compactThrough: number }>`
          SELECT compact_through_sequence AS "compactThrough"
          FROM orchestration_retention_state WHERE singleton_id = 1
        `;
        assert.isTrue(retention.every((row) => row.compactThrough < 3));
      }),
    );
  },
);
