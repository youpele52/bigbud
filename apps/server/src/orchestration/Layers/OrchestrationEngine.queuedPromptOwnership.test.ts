import { CommandId, MessageId, ProjectId, type OrchestrationCommand } from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { now, operation, threadId } from "../QueuedPromptPolicy.test.helpers.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

function submit(id: string, delivery: "queue" | "auto" = "auto"): OrchestrationCommand {
  return {
    type: "thread.message.submit",
    commandId: CommandId.makeUnsafe(`submit-${id}`),
    threadId,
    message: { messageId: MessageId.makeUnsafe(id), text: id },
    delivery,
    createdAt: now,
  };
}

describe("persisted queue ownership", () => {
  it("preserves ambiguous ownership across restart, auto/remove races, and the five-prompt cap", () =>
    withDatabase("bigbud-queue-ownership-", async (dbPath) => {
      const first = createRuntime(dbPath);
      const reserved = operation({
        state: "ambiguous",
        strategy: "native-steer",
        sessionEpoch: 0,
        expectedTurnId: null,
      });
      try {
        const engine = await engineFor(first);
        const commands: OrchestrationCommand[] = [
          ...createCommands(ProjectId.makeUnsafe("project-ownership"), [threadId]),
          submit("one", "queue"),
          {
            type: "thread.turn-control.set",
            commandId: CommandId.makeUnsafe("reserve"),
            threadId,
            operation: reserved,
            createdAt: now,
          },
        ];
        for (const command of commands) await first.runPromise(engine.dispatch(command));
      } finally {
        await first.dispose();
      }

      const second = createRuntime(dbPath);
      try {
        const engine = await engineFor(second);
        const results = await Promise.allSettled([
          ...["two", "three", "four", "five", "six"].map((id) =>
            second.runPromise(engine.dispatch(submit(id))),
          ),
          second.runPromise(
            engine.dispatch({
              type: "thread.queued-prompt.remove",
              commandId: CommandId.makeUnsafe("remove"),
              threadId,
              messageId: MessageId.makeUnsafe("one"),
              createdAt: now,
            }),
          ),
        ]);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        const value = (await second.runPromise(engine.getReadModel())).threads[0]!;
        expect(value.queuedPrompts).toHaveLength(5);
        expect(value.queuedPrompts?.[0]?.id).toBe("one");
        expect(value.pendingTurnControlOperation).toEqual(reserved);
        const events = await second.runPromise(
          Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((events) => Array.from(events))),
        );
        expect(
          events.filter(
            (event) =>
              event.type === "thread.turn-start-requested" ||
              event.type === "thread.queued-prompts-flushed",
          ),
        ).toEqual([]);
      } finally {
        await second.dispose();
      }
    }));
});
