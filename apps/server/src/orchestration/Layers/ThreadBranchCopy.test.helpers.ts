import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationMessage,
} from "@bigbud/contracts";
import type { StartThreadBranchInput } from "@bigbud/contracts/orchestration/orchestration.branchCopy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ComputerUse } from "../../computer-use/Services/ComputerUse.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadBranchCopy } from "../Services/ThreadBranchCopy.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { ThreadBranchCopyLive } from "./ThreadBranchCopy.ts";

export const PROJECT = ProjectId.makeUnsafe("branch-copy-project");
export const SOURCE = ThreadId.makeUnsafe("branch-copy-source");
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

export const at = (index: number) => new Date(BASE_MS + index * 1_000).toISOString();
export const sourceMessageId = (index: number) =>
  MessageId.makeUnsafe(`source-${String(index).padStart(5, "0")}`);

export function makeBranchCopyRuntime() {
  const engine = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(
      Layer.succeed(ComputerUse, { execute: () => Effect.die("unused"), dispose: Effect.void }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-branch-copy-" })),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(
    ThreadBranchCopyLive.pipe(
      Layer.provideMerge(Layer.mergeAll(engine, ProjectionThreadMessageRepositoryLive)),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
  );
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    runtime.runPromise(effect as Effect.Effect<A, E, never>);
  const engineOf = () => run(Effect.service(OrchestrationEngineService));
  const copyOf = () => run(Effect.service(ThreadBranchCopy));
  const sql = <A, E>(query: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
    run(Effect.flatMap(SqlClient.SqlClient.asEffect(), query));

  /** A source thread whose projection holds `messages` (written straight to the projection). */
  const seedSource = async (
    messages: ReadonlyArray<Partial<OrchestrationMessage> & { readonly index: number }>,
  ) => {
    const engine = await engineOf();
    await run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("branch-copy-project-create"),
        projectId: PROJECT,
        title: "Branch copy",
        workspaceRoot: "/tmp/branch-copy",
        defaultModelSelection: { provider: "codex", model: "gpt-5.4" },
        createdAt: at(0),
      }),
    );
    await run(engine.dispatch(createCommand(SOURCE, "Source")));
    const repository = await run(Effect.service(ProjectionThreadMessageRepository));
    for (const message of messages) {
      await run(
        repository.upsert({
          messageId: message.id ?? sourceMessageId(message.index),
          threadId: SOURCE,
          turnId: null,
          role: message.role ?? (message.index % 2 === 0 ? "user" : "assistant"),
          text: message.text ?? `message ${message.index}`,
          ...(message.attachments ? { attachments: message.attachments } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          isStreaming: message.streaming ?? false,
          createdAt: message.createdAt ?? at(message.index + 1),
          updatedAt: message.updatedAt ?? at(message.index + 1),
        }),
      );
    }
  };

  const branchInput = (
    branchThreadId: string,
    upToMessageId: MessageId | null,
  ): StartThreadBranchInput => ({
    sourceThreadId: SOURCE,
    branchThreadId: ThreadId.makeUnsafe(branchThreadId),
    upToMessageId,
    title: "Source (A)",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: at(100_000),
  });

  /** Polls the job until it leaves `copying`. */
  const waitForCopy = async (branchThreadId: string) => {
    const copy = await copyOf();
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const status = await run(copy.status(ThreadId.makeUnsafe(branchThreadId)));
      if (status && status.state !== "copying") return status;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("branch copy did not finish");
  };

  const branchMessages = (threadId: string) =>
    sql(
      (db) =>
        db<{ readonly messageId: string; readonly text: string; readonly createdAt: string }>`
        SELECT message_id AS "messageId", text, created_at AS "createdAt"
        FROM projection_thread_messages WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
    );

  return {
    run,
    sql,
    engineOf,
    copyOf,
    seedSource,
    branchInput,
    waitForCopy,
    branchMessages,
    dispose: () => runtime.dispose(),
  };
}

export const createCommand = (threadId: ThreadId, title: string) => ({
  type: "thread.create" as const,
  commandId: CommandId.makeUnsafe(`create-${threadId}`),
  threadId,
  projectId: PROJECT,
  title,
  modelSelection: { provider: "codex" as const, model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdAt: at(0),
});
