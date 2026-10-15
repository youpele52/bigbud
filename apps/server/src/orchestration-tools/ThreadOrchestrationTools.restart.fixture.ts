import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import path from "node:path";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { ProjectionCatalogQueryLive } from "../orchestration/Layers/ProjectionCatalogQuery.ts";
import {
  ProjectionCatalogQuery,
  type ProjectionCatalogQueryShape,
} from "../orchestration/Services/ProjectionCatalogQuery.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ThreadDelegationRepositoryLive } from "../persistence/Layers/ThreadDelegations.ts";
import {
  ThreadDelegationRepository,
  type ThreadDelegationRepositoryShape,
} from "../persistence/Services/ThreadDelegations.ts";

export const callerId = ThreadId.makeUnsafe("dormant-opencode-caller");
export const targetId = ThreadId.makeUnsafe("dormant-target");
export const unrelatedId = ThreadId.makeUnsafe("untouched-dormant-thread");
export const projectId = ProjectId.makeUnsafe("dormant-project");
export const otherProjectId = ProjectId.makeUnsafe("foreign-project");
export type RestartOptions = {
  provider?: "codex" | "pi";
  foreign?: boolean;
  delegated?: boolean;
  archived?: boolean;
  deleted?: boolean;
  deleting?: boolean;
};

/** Dispose the real engine, then reconstruct it from the same SQLite database. No
 * provider adapters/reactors or native APIs participate in metadata hydration. */
export async function withDormantThreads(
  options: RestartOptions,
  run: (fixture: {
    engine: Awaited<ReturnType<typeof engineFor>>;
    runtime: ReturnType<typeof createRuntime>;
    services: ReturnType<typeof makeServices>;
    repository: ThreadDelegationRepositoryShape;
    catalog: ProjectionCatalogQueryShape;
    dbPath: string;
  }) => Promise<void>,
) {
  await withDatabase("canonical-tools-dormant-", async (dbPath) => {
    const services = makeServices(dbPath);
    try {
      const repository = await services.runPromise(Effect.service(ThreadDelegationRepository));
      const catalog = await services.runPromise(Effect.service(ProjectionCatalogQuery));
      const first = createRuntime(dbPath);
      try {
        const engine = await engineFor(first);
        for (const command of [
          ...createCommands(projectId, [
            callerId,
            unrelatedId,
            ...(options.foreign ? [] : [targetId]),
          ]),
          ...(options.foreign ? createCommands(otherProjectId, [targetId]) : []),
        ]) {
          await first.runPromise(
            engine.dispatch(
              command.type === "thread.create"
                ? {
                    ...command,
                    modelSelection:
                      command.threadId === callerId
                        ? {
                            provider: "opencodeV2",
                            subProviderID: "synthetic-provider",
                            model: "synthetic-model",
                          }
                        : options.provider === "pi"
                          ? { provider: "pi", subProviderID: "anthropic", model: "claude-sonnet-4" }
                          : { provider: "codex", model: "gpt-5-codex" },
                  }
                : command.type === "project.create"
                  ? {
                      ...command,
                      workspaceRoot: path.join(path.dirname(dbPath), command.projectId),
                    }
                  : command,
            ),
          );
        }
        if (options.archived)
          await first.runPromise(
            engine.dispatch({
              type: "thread.archive",
              commandId: CommandId.makeUnsafe("archive-target"),
              threadId: targetId,
            }),
          );
        if (options.deleted || options.deleting)
          await services.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              if (options.deleted)
                yield* sql`UPDATE projection_threads SET deleted_at = '2026-10-14T00:00:00.000Z' WHERE thread_id = ${targetId}`;
              if (options.deleting)
                yield* sql`UPDATE projection_threads SET deleting_at = '2026-10-14T00:00:00.000Z' WHERE thread_id = ${targetId}`;
            }),
          );
        if (options.delegated) {
          const now = new Date().toISOString();
          await services.runPromise(
            repository.reserve({
              delegationId: "dormant-direct-child",
              callerThreadId: callerId,
              childThreadId: targetId,
              sourceMessageId: MessageId.makeUnsafe("delegation-source"),
              invocationId: "delegation-call",
              parentDelegationId: null,
              rootDelegationId: "dormant-direct-child",
              depth: 0,
              targetKind: "project",
              targetProjectId: otherProjectId,
              targetCanonicalWorkspace: null,
              childTurnId: TurnId.makeUnsafe("delegation-turn"),
              createdProjectId: null,
              createdAt: now,
              updatedAt: now,
            }),
          );
          await services.runPromise(
            repository.updateState({
              delegationId: "dormant-direct-child",
              state: "completed",
              updatedAt: now,
            }),
          );
        }
      } finally {
        await first.dispose();
      }
      const runtime = createRuntime(dbPath);
      try {
        const engine = await engineFor(runtime);
        expect(
          (await runtime.runPromise(engine.getReadModel())).threads.map((t) => t.id),
        ).not.toContain(targetId);
        expect(
          (await runtime.runPromise(engine.getReadModel())).threads.map((t) => t.id),
        ).not.toContain(callerId);
        await run({ engine, runtime, services, repository, catalog, dbPath });
      } finally {
        await runtime.dispose();
      }
    } finally {
      await services.dispose();
    }
  });
}

function makeServices(dbPath: string) {
  return ManagedRuntime.make(
    Layer.mergeAll(ProjectionCatalogQueryLive, ThreadDelegationRepositoryLive).pipe(
      Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
      Layer.provide(NodeServices.layer),
    ),
  );
}
