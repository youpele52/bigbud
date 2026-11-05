import { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { publishHtmlRender } from "./HtmlRenderTool.ts";

const threadId = ThreadId.makeUnsafe("render-thread");
const content = { title: "Comparison", html: "<table><tr><td>Hello</td></tr></table>" };
function harness() {
  const events: unknown[] = [];
  const thread = {
    id: threadId,
    deletedAt: null,
    deletingAt: null,
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn-1"),
      requestedAt: "2026-11-04T10:00:00.000Z",
      startedAt: null,
      completedAt: null as string | null,
    },
  };
  const dispatch = vi.fn((command) => {
    events.push({
      type: "thread.activity-appended",
      payload: { threadId, activity: command.activity },
    });
    return Effect.succeed({ sequence: 1 });
  });
  const engine = {
    dispatch,
    getReadModel: () => Effect.succeed({ threads: [thread] }),
    readEventsByCommandId: () => Effect.succeed(events),
  } as unknown as OrchestrationEngineShape;
  const publish = (args: unknown = content, invocationId = "call-1", expectedTurnId?: string) =>
    Effect.runPromise(
      publishHtmlRender({
        engine,
        threadId,
        arguments: args,
        invocationId,
        ...(expectedTurnId ? { expectedTurnId } : {}),
      }),
    );
  return { publish, dispatch, thread };
}

it("publishes once with authenticated thread and durable turn ownership; retry survives turn changes", async () => {
  const { publish, dispatch, thread } = harness();
  const first = await publish();
  expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
    threadId,
    activity: { turnId: "turn-1", payload: content },
  });
  thread.latestTurn.turnId = TurnId.makeUnsafe("turn-2");
  thread.latestTurn.completedAt = "2026-11-04T11:00:00.000Z";
  expect(await publish()).toEqual(first);
  expect(dispatch).toHaveBeenCalledTimes(1);
  await expect(publish({ ...content, html: "changed" })).rejects.toThrow("different HTML");
});

it("fails closed for missing identity, oversized content and settled turns", async () => {
  const { publish, dispatch, thread } = harness();
  await expect(publish(content, "")).rejects.toThrow("identity");
  await expect(publish(content, "call-old", "previous-turn")).rejects.toThrow("originating turn");
  await expect(publish({ ...content, html: "x".repeat(24_001) })).rejects.toThrow("24000");
  thread.latestTurn.completedAt = "2026-11-04T11:00:00.000Z";
  await expect(publish()).rejects.toThrow("active thread turn");
  expect(dispatch).not.toHaveBeenCalled();
});
