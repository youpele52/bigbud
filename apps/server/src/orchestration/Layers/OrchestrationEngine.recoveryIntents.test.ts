import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRecoveryIntentRepositoryLive } from "../../persistence/Layers/ThreadRecoveryIntents.ts";
import { ThreadRecoveryIntentRepository } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ComputerUseDisabledTestLayer } from "./OrchestrationEngine.test.helpers.ts";
import { createCommands, withDatabase } from "./OrchestrationEngine.test.runtime.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionOperationalStateQueryLive } from "./ProjectionOperationalStateQuery.ts";

const createdAt = "2026-10-22T10:00:00.000Z";

function createRuntime(dbPath: string) {
  const layer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ProjectionOperationalStateQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ThreadRecoveryIntentRepositoryLive),
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
    Layer.provideMerge(ComputerUseDisabledTestLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  return ManagedRuntime.make(layer);
}

function send(threadId: ThreadId, id: string): OrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(`cmd-send-${threadId}-${id}`),
    threadId,
    message: { messageId: MessageId.makeUnsafe(id), role: "user", text: id, attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt,
  };
}

function sleepContinuation(threadId: ThreadId, id: string): OrchestrationCommand {
  const text = "Continue after sleep";
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(`cmd-continue-${threadId}-${id}`),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe(id),
      role: "user",
      text,
      attachments: [],
      originSegments: [
        { kind: "sleepRecovery", actor: "automation", text, sourceThreads: [], verified: true },
      ],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt,
  };
}

/** The coordinator's state right before it dispatches: original continuing, continuation seeded. */
const seedContinuing = (threadId: ThreadId, originalId: string, continuationId: string) =>
  Effect.gen(function* () {
    const repository = yield* ThreadRecoveryIntentRepository;
    const original = MessageId.makeUnsafe(originalId);
    yield* repository.recordAccepted({
      threadId,
      messageId: original,
      provider: "codex",
      createdAt,
    });
    yield* repository.transition({
      key: { threadId, messageId: original },
      expectedRevision: 0,
      patch: {
        recoveryStatus: "continuing",
        continuationMessageId: MessageId.makeUnsafe(continuationId),
      },
      at: createdAt,
    });
    yield* repository.recordAccepted({
      threadId,
      messageId: MessageId.makeUnsafe(continuationId),
      provider: "codex",
      createdAt,
      detail: { continuationOf: original },
    });
  });

describe("OrchestrationEngine recovery intents", () => {
  it("records an intent with the turn start, and a user Stop revokes it", () =>
    withDatabase("bigbud-recovery-intents-", async (dbPath) => {
      const projectId = ProjectId.makeUnsafe("project-recovery-intents");
      const interrupted = ThreadId.makeUnsafe("thread-interrupted");
      const stopped = ThreadId.makeUnsafe("thread-stopped");
      const runtime = createRuntime(dbPath);
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      for (const command of [
        ...createCommands(projectId, [interrupted, stopped]),
        send(interrupted, "first"),
        send(stopped, "first"),
      ]) {
        await runtime.runPromise(engine.dispatch(command));
      }
      const intentOf = (threadId: ThreadId, id: string) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const repository = yield* ThreadRecoveryIntentRepository;
            return Option.getOrThrow(
              yield* repository.get({ threadId, messageId: MessageId.makeUnsafe(id) }),
            );
          }),
        );
      expect((await intentOf(interrupted, "first")).disposition).toBe("active");
      // The provider is recorded at dispatch; this command carried no model selection.
      expect((await intentOf(interrupted, "first")).provider).toBeNull();

      await runtime.runPromise(
        engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-interrupt"),
          threadId: interrupted,
          createdAt,
        }),
      );
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe("cmd-stop"),
          threadId: stopped,
          createdAt,
        }),
      );
      expect((await intentOf(interrupted, "first")).disposition).toBe("revoked");
      expect((await intentOf(stopped, "first")).disposition).toBe("revoked");
      await runtime.dispose();
    }));

  it("persists the recovery notice across a restart and records a user's resolve", () =>
    withDatabase("bigbud-recovery-notice-", async (dbPath) => {
      const projectId = ProjectId.makeUnsafe("project-recovery-notice");
      const threadId = ThreadId.makeUnsafe("thread-recovery-notice");
      const recovery = {
        status: "awaiting-user" as const,
        reason: "tool-in-flight" as const,
        toolSummary: "Run tests",
        attempt: 0,
        provider: "codex" as const,
        messageId: MessageId.makeUnsafe("first"),
        updatedAt: createdAt,
      };
      const first = createRuntime(dbPath);
      const firstEngine = await first.runPromise(Effect.service(OrchestrationEngineService));
      for (const command of [
        ...createCommands(projectId, [threadId]),
        send(threadId, "first"),
        {
          type: "thread.recovery.set" as const,
          commandId: CommandId.makeUnsafe("cmd-recovery-set"),
          threadId,
          recovery,
          createdAt,
        },
      ]) {
        await first.runPromise(firstEngine.dispatch(command));
      }
      await first.dispose();

      const second = createRuntime(dbPath);
      const secondEngine = await second.runPromise(Effect.service(OrchestrationEngineService));
      const loaded = (await second.runPromise(secondEngine.getReadModel())).threads.find(
        (thread) => thread.id === threadId,
      );
      expect(loaded?.recovery).toEqual(recovery);
      // A stale message ID is a no-op; the current one records the action.
      await second.runPromise(
        secondEngine.dispatch({
          type: "thread.recovery.resolve",
          commandId: CommandId.makeUnsafe("cmd-resolve-stale"),
          threadId,
          action: "continue",
          messageId: MessageId.makeUnsafe("older"),
          createdAt,
        }),
      );
      await second.runPromise(
        secondEngine.dispatch({
          type: "thread.recovery.resolve",
          commandId: CommandId.makeUnsafe("cmd-resolve"),
          threadId,
          action: "dismiss",
          messageId: MessageId.makeUnsafe("first"),
          createdAt,
        }),
      );
      const events = await second.runPromise(
        Stream.runCollect(secondEngine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        ),
      );
      const updates = events.flatMap((event) =>
        event.type === "thread.recovery-updated" ? [event.payload] : [],
      );
      expect(updates.map((update) => update.resolvedAction ?? null)).toEqual([null, "dismiss"]);
      const after = (await second.runPromise(secondEngine.getReadModel())).threads.find(
        (thread) => thread.id === threadId,
      );
      expect(after?.recovery).toBeNull();
      await second.dispose();
    }));

  it("refuses a sleep continuation the user overtook, and never queues it behind them", () =>
    withDatabase("bigbud-recovery-continuation-fence-", async (dbPath) => {
      const projectId = ProjectId.makeUnsafe("project-continuation-fence");
      const wanted = ThreadId.makeUnsafe("thread-continuation-wanted");
      const overtaken = ThreadId.makeUnsafe("thread-continuation-overtaken");
      const busy = ThreadId.makeUnsafe("thread-continuation-busy");
      const runtime = createRuntime(dbPath);
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      for (const command of createCommands(projectId, [wanted, overtaken, busy])) {
        await runtime.runPromise(engine.dispatch(command));
      }
      for (const threadId of [wanted, overtaken, busy]) {
        await runtime.runPromise(seedContinuing(threadId, "original", "continuation"));
      }
      // The user's message lands after the idle check: the thread is busy at dispatch.
      await runtime.runPromise(engine.dispatch(send(busy, "user-message")));
      // The user's activity settled the original intent, but the thread is idle again.
      await runtime.runPromise(
        Effect.gen(function* () {
          const repository = yield* ThreadRecoveryIntentRepository;
          yield* repository.settleRecoveringForThread({ threadId: overtaken, at: createdAt });
        }),
      );
      const outcome = (threadId: ThreadId) =>
        runtime.runPromise(
          Effect.exit(engine.dispatch(sleepContinuation(threadId, "continuation"))),
        );
      expect((await outcome(wanted))._tag).toBe("Success");
      // The command transaction refuses it: its original intent is no longer continuing.
      expect(JSON.stringify(await outcome(overtaken))).toContain("no longer wanted");
      // The decider refuses it: the thread is busy with the user's turn.
      expect(JSON.stringify(await outcome(busy))).toContain("it is not queued");

      const model = await runtime.runPromise(engine.getReadModel());
      const thread = (threadId: ThreadId) => model.threads.find((entry) => entry.id === threadId);
      const hasContinuation = (threadId: ThreadId) =>
        thread(threadId)?.messages.some((message) => message.id === "continuation") === true;
      expect(hasContinuation(wanted)).toBe(true);
      expect(hasContinuation(overtaken)).toBe(false);
      expect(hasContinuation(busy)).toBe(false);
      expect(thread(busy)?.queuedPrompts ?? []).toEqual([]);
      // The user's own turn is unaffected.
      expect(thread(busy)?.pendingTurnStart?.messageId).toBe("user-message");
      const userIntent = await runtime.runPromise(
        Effect.gen(function* () {
          const repository = yield* ThreadRecoveryIntentRepository;
          return yield* repository.get({
            threadId: busy,
            messageId: MessageId.makeUnsafe("user-message"),
          });
        }),
      );
      expect(Option.getOrThrow(userIntent).disposition).toBe("active");
      await runtime.dispose();
    }));
});
