import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type {
  OrchestrationCommandReceipt,
  OrchestrationCommandReceiptRepositoryShape,
} from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionOperationalStateQuery } from "../Services/ProjectionOperationalStateQuery.ts";
import { createEmptyReadModel } from "../projectorReadModel.ts";
import {
  asMessageId,
  asProjectId,
  ComputerUseDisabledTestLayer,
  createOrchestrationSystem,
  now,
} from "./OrchestrationEngine.test.helpers.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";

function flakyRejectedReceipts() {
  const receipts = new Map<string, OrchestrationCommandReceipt>();
  const claims = new Map<string, { version: string; digest: string }>();
  let failNextRejectedWrite = true;
  const repository: OrchestrationCommandReceiptRepositoryShape = {
    upsert: (receipt) => {
      if (receipt.status === "rejected" && failNextRejectedWrite) {
        failNextRejectedWrite = false;
        return Effect.fail(
          new PersistenceSqlError({
            operation: "test.rejectedReceipt",
            detail: "injected rejected receipt failure",
          }),
        );
      }
      receipts.set(receipt.commandId, receipt);
      return Effect.void;
    },
    getByCommandId: ({ commandId }) =>
      Effect.succeed(Option.fromNullishOr(receipts.get(commandId))),
    claimOrInspect: ({ commandId, payloadDigestVersion, payloadDigest }) => {
      const claim = claims.get(commandId);
      if (claim && (claim.version !== payloadDigestVersion || claim.digest !== payloadDigest)) {
        return Effect.succeed({
          status: "conflict" as const,
          storedPayloadDigestVersion: claim.version,
          storedPayloadDigest: claim.digest,
        });
      }
      claims.set(commandId, { version: payloadDigestVersion, digest: payloadDigest });
      const receipt = receipts.get(commandId);
      return Effect.succeed(
        receipt ? { status: "existing" as const, receipt } : { status: "claimed" as const },
      );
    },
  };
  return repository;
}

function expectUnknownPersistenceFailure(result: Promise<unknown>, commandId: CommandId) {
  return expect(result).rejects.toMatchObject({
    _tag: "OrchestrationCommandOutcomePersistenceError",
    commandId,
  });
}

describe("OrchestrationEngine rejected receipt durability", () => {
  it("keeps a preflight rejection unknown until its receipt commits", async () => {
    const system = await createOrchestrationSystem({ receipts: flakyRejectedReceipts() });
    const commandId = CommandId.makeUnsafe("cmd-preflight-receipt-retry");
    const command = {
      type: "thread.turn.start" as const,
      commandId,
      threadId: ThreadId.makeUnsafe("missing-preflight-thread"),
      message: {
        messageId: asMessageId("missing-preflight-message"),
        role: "user" as const,
        text: "retry me",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt: now(),
    };

    await expectUnknownPersistenceFailure(system.run(system.engine.dispatch(command)), commandId);
    await expect(system.run(system.engine.getCommandOutcome!(commandId))).resolves.toMatchObject({
      commandId,
      status: "unknown",
    });
    await expect(system.run(system.engine.dispatch(command))).rejects.toThrow("does not exist");
    await expect(system.run(system.engine.getCommandOutcome!(commandId))).resolves.toMatchObject({
      commandId,
      status: "rejected",
    });
    await system.dispose();
  });

  it("keeps a processor invariant rejection unknown until its receipt commits", async () => {
    const system = await createOrchestrationSystem({ receipts: flakyRejectedReceipts() });
    const createdAt = now();
    const projectId = asProjectId("project-processor-receipt-retry");
    const threadId = ThreadId.makeUnsafe("thread-processor-receipt-retry");
    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-processor-receipt-retry"),
        projectId,
        title: "Receipt retry",
        workspaceRoot: "/tmp/project-processor-receipt-retry",
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-processor-receipt-original"),
        threadId,
        projectId,
        title: "Original",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const commandId = CommandId.makeUnsafe("cmd-thread-processor-receipt-retry");
    const duplicate = {
      type: "thread.create" as const,
      commandId,
      threadId,
      projectId,
      title: "Duplicate",
      modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      branch: null,
      worktreePath: null,
      createdAt,
    };

    await expectUnknownPersistenceFailure(system.run(system.engine.dispatch(duplicate)), commandId);
    await expect(system.run(system.engine.getCommandOutcome!(commandId))).resolves.toMatchObject({
      commandId,
      status: "unknown",
    });
    await expect(system.run(system.engine.dispatch(duplicate))).rejects.toThrow("already exists");
    await expect(system.run(system.engine.getCommandOutcome!(commandId))).resolves.toMatchObject({
      commandId,
      status: "rejected",
      reason: "thread_already_exists",
    });
    await system.dispose();
  });

  it("does not persist hydration failures as deterministic rejections", async () => {
    const commandId = CommandId.makeUnsafe("cmd-hydration-operational-failure");
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(
          Layer.succeed(ProjectionOperationalStateQuery, {
            getStartupOperationalState: () =>
              Effect.succeed(createEmptyReadModel("2026-08-27T00:00:00.000Z")),
            getThreadOperationalState: () =>
              Effect.fail(
                new PersistenceSqlError({
                  operation: "test.hydrate",
                  detail: "hydration failed",
                }),
              ),
            getFullThreadHistory: () =>
              Effect.fail(
                new PersistenceSqlError({
                  operation: "test.hydrateHistory",
                  detail: "history hydration failed",
                }),
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(OrchestrationProjectionPipeline, {
            bootstrap: Effect.void,
            backfillUsageContributions: Effect.void,
            ensureVerifiedBaselineThrough: () => Effect.void,
            compactVerifiedPrefix: () => Effect.void,
            projectEvent: () => Effect.void,
          }),
        ),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ComputerUseDisabledTestLayer),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.turn.start",
          commandId,
          threadId: ThreadId.makeUnsafe("thread-hydration-operational-failure"),
          message: {
            messageId: asMessageId("message-hydration-operational-failure"),
            role: "user",
            text: "hydrate",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("history hydration failed");
    await expect(runtime.runPromise(engine.getCommandOutcome!(commandId))).resolves.toMatchObject({
      commandId,
      status: "unknown",
    });
    await runtime.dispose();
  });
});
