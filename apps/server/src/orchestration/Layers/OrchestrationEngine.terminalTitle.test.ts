import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeTerminalTitleListener } from "./TerminalThreadTitleReactor.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const threadId = ThreadId.makeUnsafe("terminal-title");
const now = "2026-10-17T00:00:00.000Z";
const rename = (id: string, title: string): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: CommandId.makeUnsafe(id),
  threadId,
  title,
});
const chat = (): OrchestrationCommand => ({
  type: "thread.message.submit",
  commandId: CommandId.makeUnsafe("submit-chat"),
  threadId,
  message: { messageId: MessageId.makeUnsafe("chat"), text: "Review authentication" },
  delivery: "queue",
  createdAt: now,
});
const task = (terminalId: string, title: string) => ({
  type: "output" as const,
  threadId,
  terminalId,
  createdAt: now,
  data: `\x1b]2;Gemini CLI: ${title}\x07`,
});

describe("persisted terminal naming", () => {
  it.each(["terminal", "manual", "chat"] as const)(
    "preserves %s ownership across a real database restart",
    (source) =>
      withDatabase("bigbud-terminal-title-", async (dbPath) => {
        const first = createRuntime(dbPath);
        try {
          const engine = await engineFor(first);
          for (const command of createCommands(ProjectId.makeUnsafe("title-project"), [threadId])) {
            await first.runPromise(
              engine.dispatch(
                command.type === "thread.create" ? { ...command, title: "New thread" } : command,
              ),
            );
          }
          if (source === "terminal") {
            await Effect.runPromise(
              makeTerminalTitleListener(engine)(task("main", "Repair terminal recovery")),
            );
          } else if (source === "manual") {
            await first.runPromise(engine.dispatch(rename("user:rename", "New thread")));
          } else {
            await first.runPromise(engine.dispatch(chat()));
            await first.runPromise(
              engine.dispatch({
                type: "thread.queued-prompt.remove",
                commandId: CommandId.makeUnsafe("remove-chat"),
                threadId,
                messageId: MessageId.makeUnsafe("chat"),
                createdAt: now,
              }),
            );
          }
        } finally {
          await first.dispose();
        }
        const second = createRuntime(dbPath);
        try {
          const engine = await engineFor(second);
          const listener = makeTerminalTitleListener(engine);
          await Effect.runPromise(listener(task("side-terminal", "Late terminal title")));
          if (source !== "chat") {
            await second.runPromise(
              engine.dispatch(rename("server:thread-title-seed:stale", "Late chat seed")),
            );
            await second.runPromise(
              engine.dispatch(rename("server:thread-title-rename:stale", "Late generated title")),
            );
            await second.runPromise(
              engine.dispatch(
                rename("provider:thread-meta-update:stale", "Late native chat title"),
              ),
            );
          }
          const thread = (await second.runPromise(engine.getReadModel())).threads.find(
            (item) => item.id === threadId,
          )!;
          expect(thread.title).toBe(
            source === "terminal" ? "Repair terminal recovery" : "New thread",
          );
          // A fresh manual rename is always authoritative regardless of the original source.
          await second.runPromise(engine.dispatch(rename("user:final-rename", "My chosen title")));
          expect(
            (await second.runPromise(engine.getReadModel())).threads.find(
              (item) => item.id === threadId,
            )?.title,
          ).toBe("My chosen title");
        } finally {
          await second.dispose();
        }
      }),
  );

  it("does not reserve naming rights for terminal use before a chat prompt", () =>
    withDatabase("bigbud-title-order-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const engine = await engineFor(runtime);
        for (const command of createCommands(ProjectId.makeUnsafe("title-project"), [threadId])) {
          await runtime.runPromise(
            engine.dispatch(
              command.type === "thread.create" ? { ...command, title: "New thread" } : command,
            ),
          );
        }
        const listener = makeTerminalTitleListener(engine);
        await Effect.runPromise(
          listener({
            type: "output",
            threadId,
            terminalId: "main",
            createdAt: now,
            data: "\x1b]2;bun dev\x07",
          }),
        );
        await runtime.runPromise(engine.dispatch(chat()));
        await Effect.runPromise(listener(task("main", "Late agent task")));
        await runtime.runPromise(
          engine.dispatch(rename("server:thread-title-seed:chat", "Review authentication")),
        );
        expect(
          (await runtime.runPromise(engine.getReadModel())).threads.find(
            (item) => item.id === threadId,
          )?.title,
        ).toBe("Review authentication");
      } finally {
        await runtime.dispose();
      }
    }));
});
