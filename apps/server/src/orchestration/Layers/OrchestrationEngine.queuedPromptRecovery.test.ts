import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { sendThreadMessageViaOrchestration } from "../../orchestration-tools/ThreadOrchestrationTools.sendMessage.ts";
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

function createRuntime(dbPath: string) {
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

async function engineFor(runtime: Runtime) {
  return runtime.runPromise(Effect.service(OrchestrationEngineService));
}

async function dispatchAll(runtime: Runtime, commands: ReadonlyArray<OrchestrationCommand>) {
  const engine = await engineFor(runtime);
  for (const command of commands) await runtime.runPromise(engine.dispatch(command));
  return engine;
}

const createdAt = "2026-08-01T00:00:00.000Z";

function createCommands(projectId: ProjectId, threadIds: ReadonlyArray<ThreadId>) {
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

function queueCommand(threadId: ThreadId, id: string, text = id): OrchestrationCommand {
  return {
    type: "thread.message.submit",
    commandId: CommandId.makeUnsafe(`cmd-queue-${id}`),
    threadId,
    message: { messageId: MessageId.makeUnsafe(id), text },
    delivery: "queue",
    createdAt,
  };
}

function gateCommand(
  threadId: ThreadId,
  kind: "approval.requested" | "user-input.requested" | "approval.resolved",
  requestId: string,
): OrchestrationCommand {
  return {
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe(`cmd-${kind}-${threadId}`),
    threadId,
    activity: {
      id: EventId.makeUnsafe(`activity-${kind}-${threadId}`),
      tone: kind === "approval.requested" ? "approval" : "info",
      kind,
      summary: kind,
      payload: { requestId },
      turnId: null,
      createdAt,
    },
    createdAt,
  };
}

async function withDatabase(prefix: string, run: (dbPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(join(directory, "orchestration.sqlite"));
  } finally {
    await rm(directory, { recursive: true });
  }
}

describe("OrchestrationEngine queued prompt recovery", () => {
  it("flushes a persisted idle queue exactly once across restarts", () =>
    withDatabase("bigbud-queue-recovery-", async (dbPath) => {
      const projectId = ProjectId.makeUnsafe("project-recovery");
      const threadId = ThreadId.makeUnsafe("thread-recovery");
      const first = createRuntime(dbPath);
      const firstEngine = await dispatchAll(first, [
        ...createCommands(projectId, [threadId]),
        queueCommand(threadId, "message-recovery", "Continue"),
      ]);
      expect(
        (await first.runPromise(firstEngine.getReadModel())).threads[0]?.queuedPrompts,
      ).toHaveLength(1);
      await first.dispose();

      const second = createRuntime(dbPath);
      const secondEngine = await engineFor(second);
      await vi.waitFor(async () => {
        const thread = (await second.runPromise(secondEngine.getReadModel())).threads[0];
        expect(thread?.queuedPrompts).toEqual([]);
        expect(thread?.messages.some((message) => message.text.includes("Continue"))).toBe(true);
      });
      await second.dispose();

      const third = createRuntime(dbPath);
      const thirdEngine = await engineFor(third);
      const events = await third.runPromise(
        Stream.runCollect(thirdEngine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
      );
      expect(
        events.filter(
          (event) =>
            event.type === "thread.message-sent" && event.payload.text.includes("Continue"),
        ),
      ).toHaveLength(1);
      await third.dispose();
    }));

  it("keeps persisted approval and user-input gated queues across restart", () =>
    withDatabase("bigbud-queue-gates-", async (dbPath) => {
      const projectId = ProjectId.makeUnsafe("project-gates");
      const approvalThread = ThreadId.makeUnsafe("thread-approval-gate");
      const inputThread = ThreadId.makeUnsafe("thread-input-gate");
      const first = createRuntime(dbPath);
      await dispatchAll(first, [
        ...createCommands(projectId, [approvalThread, inputThread]),
        gateCommand(approvalThread, "approval.requested", "approval-1"),
        gateCommand(inputThread, "user-input.requested", "input-1"),
        queueCommand(approvalThread, "approval-prompt"),
        queueCommand(inputThread, "input-prompt"),
      ]);
      await first.dispose();

      const second = createRuntime(dbPath);
      const engine = await engineFor(second);
      const readModel = await second.runPromise(engine.getReadModel());
      expect(
        readModel.threads.find((thread) => thread.id === approvalThread)?.queuedPrompts,
      ).toHaveLength(1);
      expect(
        readModel.threads.find((thread) => thread.id === inputThread)?.queuedPrompts,
      ).toHaveLength(1);
      await second.dispose();
    }));

  it("flushes an exact persisted prefix while preserving a concurrent suffix", () =>
    withDatabase("bigbud-queue-prefix-", async (dbPath) => {
      const projectId = ProjectId.makeUnsafe("project-prefix");
      const threadId = ThreadId.makeUnsafe("thread-prefix");
      const first = createRuntime(dbPath);
      await dispatchAll(first, [
        ...createCommands(projectId, [threadId]),
        gateCommand(threadId, "approval.requested", "approval-prefix"),
        queueCommand(threadId, "prefix-a", "Alpha"),
        queueCommand(threadId, "prefix-b", "Beta"),
      ]);
      await first.dispose();

      const second = createRuntime(dbPath);
      const engine = await engineFor(second);
      const observed = (
        await second.runPromise(engine.getReadModel())
      ).threads[0]!.queuedPrompts!.map((prompt) => prompt.id);
      await second.runPromise(engine.dispatch(queueCommand(threadId, "suffix-c", "Gamma")));
      await second.runPromise(
        engine.dispatch(gateCommand(threadId, "approval.resolved", "approval-prefix")),
      );
      await second.runPromise(
        engine.dispatch({
          type: "thread.queued-prompt.flush",
          commandId: CommandId.makeUnsafe("cmd-prefix-flush"),
          threadId,
          messageIds: observed,
          messageId: MessageId.makeUnsafe("message-prefix-flush"),
          createdAt,
        }),
      );
      const thread = (await second.runPromise(engine.getReadModel())).threads[0]!;
      expect(thread.queuedPrompts?.map((prompt) => prompt.text)).toEqual(["Gamma"]);
      expect(thread.messages.at(-1)?.text).toContain("- Alpha\n- Beta");
      await second.dispose();

      const third = createRuntime(dbPath);
      const thirdEngine = await engineFor(third);
      const persisted = (await third.runPromise(thirdEngine.getReadModel())).threads[0]!;
      expect(persisted.queuedPrompts?.map((prompt) => prompt.text)).toEqual(["Gamma"]);
      const events = await third.runPromise(
        Stream.runCollect(thirdEngine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
      );
      expect(
        events.some(
          (event) =>
            event.type === "thread.message-sent" && event.payload.text.includes("- Alpha\n- Beta"),
        ),
      ).toBe(true);
      await third.dispose();
    }));

  it("returns the original queued outcome when a committed send is retried after restart", () =>
    withDatabase("bigbud-send-retry-", async (dbPath) => {
      const projectId = ProjectId.makeUnsafe("project-send-retry");
      const callerId = ThreadId.makeUnsafe("thread-send-caller");
      const targetId = ThreadId.makeUnsafe("thread-send-target");
      const input = {
        callerThreadId: callerId,
        threadId: targetId,
        message: "Retry me",
        delivery: "auto" as const,
        invocationId: "stable-invocation",
      };
      const first = createRuntime(dbPath);
      const firstEngine = await dispatchAll(first, [
        ...createCommands(projectId, [callerId, targetId]),
        gateCommand(callerId, "approval.requested", "approval-caller"),
        gateCommand(targetId, "approval.requested", "approval-retry"),
      ]);
      await expect(
        first.runPromise(
          sendThreadMessageViaOrchestration({ orchestrationEngine: firstEngine, ...input }),
        ),
      ).resolves.toEqual({ delivery: "queued", queuePosition: 1 });
      await first.dispose();

      const second = createRuntime(dbPath);
      const secondEngine = await engineFor(second);
      await expect(
        second.runPromise(
          sendThreadMessageViaOrchestration({ orchestrationEngine: secondEngine, ...input }),
        ),
      ).resolves.toEqual({ delivery: "queued", queuePosition: 1 });
      expect(
        (await second.runPromise(secondEngine.getReadModel())).threads.find(
          (thread) => thread.id === targetId,
        )?.queuedPrompts,
      ).toHaveLength(1);
      await second.dispose();
    }));
});
