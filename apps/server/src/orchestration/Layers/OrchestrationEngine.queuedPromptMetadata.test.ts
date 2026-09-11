import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const now = "2026-08-01T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("thread-metadata-replay");
const settings = {
  modelSelection: {
    provider: "codex" as const,
    model: "captured-model",
    options: { reasoningEffort: "high" as const, fastMode: true },
  },
  runtimeMode: "approval-required" as const,
  interactionMode: "plan" as const,
};
function queueCommand(id: string): OrchestrationCommand {
  return {
    type: "thread.message.submit",
    commandId: CommandId.makeUnsafe(`queue-${id}`),
    threadId,
    message: { messageId: MessageId.makeUnsafe(id), text: id },
    delivery: "queue",
    createdAt: now,
    ...(id === "legacy" ? {} : settings),
  };
}
const capturedPrompt = (id: string) => ({ id, text: id, createdAt: now, ...settings });
const session = (suffix: string, active: boolean): OrchestrationCommand => ({
  type: "thread.session.set",
  commandId: CommandId.makeUnsafe(`session-${suffix}`),
  threadId,
  session: {
    threadId,
    status: active ? "running" : "ready",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: active ? TurnId.makeUnsafe("old-turn") : null,
    lastError: null,
    updatedAt: now,
  },
  createdAt: now,
});

describe("queued prompt metadata persistence", () => {
  it("preserves explicit metadata in SQL, replay, and compatible lifecycle starts after settings drift", () =>
    withDatabase("bigbud-queue-metadata-", async (dbPath) => {
      const first = createRuntime(dbPath);
      try {
        const engine = await engineFor(first);
        const commands: OrchestrationCommand[] = [
          ...createCommands(ProjectId.makeUnsafe("project-metadata"), [threadId]),
          session("busy", true),
          ...["one", "two", "legacy"].map(queueCommand),
          {
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("drift-model"),
            threadId,
            modelSelection: { provider: "codex", model: "new-default-model" },
          },
          {
            type: "thread.runtime-mode.set",
            commandId: CommandId.makeUnsafe("drift-runtime"),
            threadId,
            runtimeMode: "full-access",
            createdAt: now,
          },
          {
            type: "thread.interaction-mode.set",
            commandId: CommandId.makeUnsafe("drift-interaction"),
            threadId,
            interactionMode: "default",
            createdAt: now,
          },
        ];
        for (const command of commands) await first.runPromise(engine.dispatch(command));
        const queued = (await first.runPromise(engine.getReadModel())).threads[0]!.queuedPrompts!;
        expect(queued.slice(0, 2)).toEqual(["one", "two"].map(capturedPrompt));
        expect(queued[2]).toEqual({ id: "legacy", text: "legacy", createdAt: now });
      } finally {
        await first.dispose();
      }

      const db = new DatabaseSync(dbPath);
      try {
        const row = db
          .prepare("SELECT queued_prompts_json FROM projection_threads WHERE thread_id = ?")
          .get(threadId)!;
        expect(JSON.parse(row.queued_prompts_json as string)[0]).toMatchObject(settings);
      } finally {
        db.close();
      }

      const second = createRuntime(dbPath);
      try {
        const engine = await engineFor(second);
        const queued = (await second.runPromise(engine.getReadModel())).threads[0]!.queuedPrompts!;
        expect(queued[0]).toMatchObject(settings);
        expect(queued[2]).not.toHaveProperty("modelSelection");
        await second.runPromise(engine.dispatch(session("settled", false)));
        await vi.waitFor(async () => {
          const value = (await second.runPromise(engine.getReadModel())).threads[0]!;
          expect(value.queuedPrompts?.map((prompt) => prompt.id)).toEqual(["legacy"]);
        });
        const events = await second.runPromise(
          Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((events) => Array.from(events))),
        );
        const starts = events.filter((event) => event.type === "thread.turn-start-requested");
        expect(starts).toHaveLength(1);
        expect(starts[0]!.payload).toMatchObject(settings);
        expect(
          events.find((event) => event.type === "thread.prompt-queued")?.payload,
        ).toMatchObject({ prompt: settings });

        await second.runPromise(engine.dispatch(session("next-settled", false)));
        await vi.waitFor(async () => {
          expect(
            (await second.runPromise(engine.getReadModel())).threads[0]!.queuedPrompts,
          ).toEqual([]);
        });
        const finalEvents = await second.runPromise(
          Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((events) => Array.from(events))),
        );
        const finalStarts = finalEvents.filter(
          (event) => event.type === "thread.turn-start-requested",
        );
        expect(finalStarts).toHaveLength(2);
        expect(finalStarts[1]!.payload).toMatchObject({
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        expect(finalStarts[1]!.payload).not.toHaveProperty("modelSelection");
      } finally {
        await second.dispose();
      }
    }));
});
