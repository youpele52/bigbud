import { CommandId, EventId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { HTML_RENDER_ACTIVITY_KIND } from "@bigbud/contracts/orchestration/htmlRender.ts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { decideThreadActivityAppendCommand } from "./deciderThreads.turn.start.ts";

it("fences an HTML publication if its originating turn settles or changes before dispatch", async () => {
  const threadId = ThreadId.makeUnsafe("html-thread");
  const turnId = TurnId.makeUnsafe("originating-turn");
  const createdAt = "2026-11-04T10:00:00.000Z";
  const command = {
    type: "thread.activity.append" as const,
    commandId: CommandId.makeUnsafe("render-command"),
    threadId,
    createdAt,
    activity: {
      id: EventId.makeUnsafe("html-1"),
      kind: HTML_RENDER_ACTIVITY_KIND,
      tone: "info" as const,
      summary: "Chart",
      payload: { title: "Chart", html: "<p>Chart</p>" },
      turnId,
      createdAt,
    },
  };
  for (const latestTurn of [
    { turnId: TurnId.makeUnsafe("replacement-turn"), completedAt: null },
    { turnId, completedAt: createdAt },
  ]) {
    const readModel = {
      threads: [{ id: threadId, deletedAt: null, deletingAt: null, latestTurn, activities: [] }],
    } as unknown as OrchestrationReadModel;
    await expect(
      Effect.runPromise(decideThreadActivityAppendCommand({ command, readModel })),
    ).rejects.toThrow("no longer owns");
  }
});
