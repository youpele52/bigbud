import { CommandId, ProjectId, ThreadId } from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, ManagedRuntime, Path } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ComputerUse } from "../../computer-use/Services/ComputerUse.ts";
import { isPersistenceError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionBaselineRepository } from "../../persistence/Services/ProjectionBaselines.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { makeProjectionBaselineOperations } from "./ProjectionPipeline.baseline.ts";
import { makeProjectionBaselineCoordinator } from "./ProjectionPipeline.baseline.coordination.ts";
import { verifyCandidateInWorkspace } from "./ProjectionPipeline.baseline.workspace.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.helpers.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

// D-2 (live arm64 re-run): after a project cascade, cascade cleanup waited the whole 15-minute
// baseline failure cooldown. The verification workspace built its repositories with
// `Layer.build`, which reuses the caller's memo map, so the "workspace" baseline repository was
// the live one: its final digest hashed the live projections, not the replay. The cascade's
// `project.deleted` landed while the intermediate candidate was being verified, the digest no
// longer matched, and the matching candidate was rejected. The runtime below builds the live
// pipeline first, exactly as the server does, so the memoisation is reproduced.

const at = "2026-11-18T00:00:00.000Z";
const modelSelection = { provider: "codex", model: "gpt-5.4" } as const;
const projectorNames = Object.values(ORCHESTRATION_PROJECTOR_NAMES);

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
        ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-baseline-live-digest-" }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

type Runtime = ReturnType<typeof makeRuntime>;

const runWith =
  (runtime: Runtime) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    runtime.runPromise(effect as Effect.Effect<A, E, never>);

/** A project with a parent and a child thread, then a project delete that cascades them. */
const startProjectCascade = async (runtime: Runtime, projectId: ProjectId) => {
  const run = runWith(runtime);
  const engine = await run(Effect.service(OrchestrationEngineService));
  await run(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe(`${projectId}-create`),
      projectId,
      title: "Cascade",
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: modelSelection,
      createdAt: at,
    }),
  );
  for (const [id, parent] of [
    ["parent", undefined],
    ["child", "parent"],
  ] as const) {
    await run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`${projectId}-create-${id}`),
        threadId: ThreadId.makeUnsafe(`${projectId}-${id}`),
        projectId,
        title: id,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        ...(parent
          ? {
              parentThread: {
                threadId: ThreadId.makeUnsafe(`${projectId}-${parent}`),
                projectId,
                title: parent,
              },
            }
          : {}),
        createdAt: at,
      }),
    );
  }
  await run(
    engine.dispatch({
      type: "project.delete",
      commandId: CommandId.makeUnsafe(`${projectId}-delete`),
      projectId,
    }),
  );
  return engine;
};

it("verifies a cascade's intermediate baseline while the project delete lands, without cooldown", async () => {
  const runtime = makeRuntime();
  const run = runWith(runtime);
  try {
    const projectId = ProjectId.makeUnsafe("live-digest");
    const engine = await startProjectCascade(runtime, projectId);
    const threadDeleted = await run(
      engine.dispatch({
        type: "thread.delete.finalize",
        commandId: CommandId.makeUnsafe("live-digest-finalize-parent"),
        threadId: ThreadId.makeUnsafe("live-digest-parent"),
        threadIds: ["live-digest-parent", "live-digest-child"].map((id) => ThreadId.makeUnsafe(id)),
        mode: "subtree",
        origin: "project-cascade",
        createdAt: at,
      }),
    );
    const finalizeProject = engine.dispatch({
      type: "project.delete.finalize",
      commandId: CommandId.makeUnsafe("live-digest-finalize-project"),
      projectId,
      createdAt: at,
    });

    // The candidate is captured at the thread deletion. The cascade's project.deleted commits
    // while that candidate is still replaying (deterministically: on its first replay read).
    const eventStore = await run(Effect.service(OrchestrationEventStore));
    const baselines = await run(Effect.service(ProjectionBaselineRepository));
    let projectSequence: number | undefined;
    const racingEventStore: OrchestrationEventStoreShape = {
      ...eventStore,
      readReplay: (sequenceExclusive, limit) =>
        Effect.gen(function* () {
          if (projectSequence === undefined) {
            projectSequence = (yield* Effect.orDie(finalizeProject)).sequence;
          }
          return yield* eventStore.readReplay(sequenceExclusive, limit);
        }),
    };
    const services = await run(
      Effect.all([
        Effect.service(FileSystem.FileSystem),
        Effect.service(Path.Path),
        Effect.service(ServerConfig),
      ]),
    );
    // The same composition as OrchestrationProjectionPipelineLive, with the racing store.
    const operations = makeProjectionBaselineOperations({
      eventStore,
      baselines,
      projectorNames,
      verifyCandidate: (candidate, source) =>
        verifyCandidateInWorkspace({
          candidate,
          source,
          readSource: baselines.payloadSource,
          eventStore: racingEventStore,
          projectorNames,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, services[0]),
          Effect.provideService(Path.Path, services[1]),
          Effect.provideService(ServerConfig, services[2]),
          Effect.mapError((error) =>
            isPersistenceError(error)
              ? error
              : toPersistenceSqlError("ProjectionPipeline.verify:workspace")(error),
          ),
        ),
    });
    const ensureCovered = await run(
      makeProjectionBaselineCoordinator({ baselines, compact: operations.verifyThrough() }),
    );

    // The clock never moves: a rejection here would hold both requests for the 15-minute
    // failure cooldown, which is exactly the live stall.
    const [threadCoverage, projectCoverage] = await run(
      Effect.gen(function* () {
        const threadExit = yield* Effect.exit(ensureCovered(threadDeleted.sequence));
        const projectExit = yield* Effect.exit(ensureCovered(projectSequence ?? Infinity));
        return [threadExit, projectExit] as const;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    assert.isTrue(Exit.isSuccess(threadCoverage), "thread deletion coverage");
    assert.equal(projectSequence, threadDeleted.sequence + 1);
    assert.isTrue(Exit.isSuccess(projectCoverage), "project deletion coverage");

    const sql = await run(Effect.service(SqlClient.SqlClient));
    const rows = await run(sql<{ readonly sequence: number; readonly status: string }>`
      SELECT sequence, verification_status AS status FROM projection_baselines
    `);
    assert.deepEqual(rows, [{ sequence: projectSequence!, status: "verified" }]);
  } finally {
    await runtime.dispose();
  }
});

it("rejects a candidate the replay does not reproduce, even when live projections are idle", async () => {
  const runtime = makeRuntime();
  const run = runWith(runtime);
  try {
    const projectId = ProjectId.makeUnsafe("tampered");
    const engine = await run(Effect.service(OrchestrationEngineService));
    const pipeline = await run(Effect.service(OrchestrationProjectionPipeline));
    const sql = await run(Effect.service(SqlClient.SqlClient));
    const frontier = (
      await run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("tampered-create"),
          projectId,
          title: "Tampered",
          workspaceRoot: "/tmp/tampered",
          defaultModelSelection: modelSelection,
          createdAt: at,
        }),
      )
    ).sequence;

    // A projection change no event explains. Replaying the canonical history cannot produce
    // it, so a candidate captured now must fail verification. Before the fix the digest read
    // the same live rows the candidate was captured from, and this candidate was accepted.
    await run(sql`UPDATE projection_projects SET title = 'not from any event'
      WHERE project_id = ${projectId}`);
    const coverage = await run(
      Effect.exit(pipeline.ensureVerifiedBaselineThroughWithoutCompaction!(frontier)),
    );

    assert.isTrue(Exit.isFailure(coverage));
    const rows = await run(sql<{ readonly sequence: number }>`
      SELECT sequence FROM projection_baselines
    `);
    assert.deepEqual(rows, []);
  } finally {
    await runtime.dispose();
  }
});
