import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const createdAt = "2026-08-01T00:00:00.000Z";

function send(threadId: ThreadId, id: string): OrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(`cmd-send-${id}`),
    threadId,
    message: { messageId: MessageId.makeUnsafe(id), role: "user", text: id, attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt,
  };
}

function sessionReady(threadId: ThreadId): OrchestrationCommand {
  return {
    type: "thread.session.set",
    commandId: CommandId.makeUnsafe(`cmd-ready-${threadId}`),
    threadId,
    session: {
      threadId,
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: createdAt,
    },
    createdAt,
  };
}

describe("OrchestrationEngine pending turn start", () => {
  it("holds the queue durably, then settles an orphaned start once after restart", () =>
    withDatabase("bigbud-pending-start-", async (dbPath) => {
      const projectId = ProjectId.makeUnsafe("project-pending-start");
      const threadId = ThreadId.makeUnsafe("thread-pending-start");
      // No provider reactor runs here, so a requested turn never binds: exactly the
      // state a server restart leaves behind mid-start.
      const first = createRuntime(dbPath);
      const firstEngine = await engineFor(first);
      for (const command of [
        ...createCommands(projectId, [threadId]),
        send(threadId, "first"),
        sessionReady(threadId),
        send(threadId, "second"),
      ]) {
        await first.runPromise(firstEngine.dispatch(command));
      }
      const before = (await first.runPromise(firstEngine.getReadModel())).threads[0]!;
      expect(before.session?.status).toBe("ready");
      expect(before.pendingTurnStart?.messageId).toBe("first");
      expect(before.queuedPrompts?.map((prompt) => prompt.id)).toEqual(["second"]);
      await first.dispose();

      // The gate was loaded from the projection, settled as a stopped session, and the
      // queue flushed behind it in order. No reactor runs here to deliver `second`, so its own
      // start is orphaned in turn; integration/pendingTurnStart.restart covers delivery.
      const second = createRuntime(dbPath);
      const secondEngine = await engineFor(second);
      await vi.waitFor(async () => {
        const thread = (await second.runPromise(secondEngine.getReadModel())).threads[0]!;
        expect(thread.queuedPrompts).toEqual([]);
        expect(thread.pendingTurnStart?.messageId).toBe("second");
      });
      await second.dispose();

      const third = createRuntime(dbPath);
      const thirdEngine = await engineFor(third);
      await vi.waitFor(async () => {
        const thread = (await third.runPromise(thirdEngine.getReadModel())).threads[0]!;
        expect(thread.pendingTurnStart).toBeNull();
      });
      const events = await third.runPromise(
        Stream.runCollect(thirdEngine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
      );
      const userMessages = events.flatMap((event) =>
        event.type === "thread.message-sent" && event.payload.role === "user"
          ? [event.payload.messageId]
          : [],
      );
      expect(userMessages).toEqual(["first", "second"]);
      const orphanSettlements = events.filter(
        (event) =>
          event.type === "thread.session-set" &&
          String(event.commandId).startsWith("server:orphaned-turn-start:"),
      );
      expect(orphanSettlements).toHaveLength(2);
      await third.dispose();
    }));
});
