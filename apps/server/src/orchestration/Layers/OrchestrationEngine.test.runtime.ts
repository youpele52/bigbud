import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  type OrchestrationCommand,
  type ThreadId,
} from "@bigbud/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ComputerUseDisabledTestLayer } from "./OrchestrationEngine.test.helpers.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionOperationalStateQueryLive } from "./ProjectionOperationalStateQuery.ts";

export function createRuntime(dbPath: string) {
  const layer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ProjectionOperationalStateQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(makeSqlitePersistenceLive(dbPath)),
    Layer.provideMerge(ComputerUseDisabledTestLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  return ManagedRuntime.make(layer);
}

type Runtime = ReturnType<typeof createRuntime>;

export async function engineFor(runtime: Runtime) {
  return runtime.runPromise(Effect.service(OrchestrationEngineService));
}

export async function withDatabase(
  prefix: string,
  run: (dbPath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(join(directory, "orchestration.sqlite"));
  } finally {
    await rm(directory, { recursive: true });
  }
}

const createdAt = "2026-08-01T00:00:00.000Z";

export function createCommands(projectId: ProjectId, threadIds: ReadonlyArray<ThreadId>) {
  return [
    {
      type: "project.create",
      commandId: CommandId.makeUnsafe(`cmd-project-${projectId}`),
      projectId,
      title: "Recovery",
      workspaceRoot: null,
      defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
      createdAt,
    },
    ...threadIds.map(
      (threadId): OrchestrationCommand => ({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`cmd-thread-${threadId}`),
        threadId,
        projectId,
        title: `Thread ${threadId}`,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    ),
  ] satisfies ReadonlyArray<OrchestrationCommand>;
}
