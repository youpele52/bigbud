import { MessageId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvent } from "./events.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

describe("incremental running session updates", () => {
  it("preserves Pi multi-turn running session after assistant message completes", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-pi"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: MessageId.makeUnsafe("assistant-pi"),
      },
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-pi"),
          role: "assistant",
          text: "first pass done",
          turnId: TurnId.makeUnsafe("turn-pi"),
          createdAt: "2026-02-27T00:00:01.000Z",
          completedAt: "2026-02-27T00:00:01.000Z",
          streaming: false,
        },
      ],
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "pi",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-pi"),
          sessionEpoch: 0,
          reason: "turn.completed.awaiting_agent_end",
          lastError: null,
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
      }),
    );

    expect(next.threads[0]?.session?.status).toBe("running");
    expect(next.threads[0]?.session?.orchestrationStatus).toBe("running");
    expect(next.threads[0]?.session?.activeTurnId).toBe(TurnId.makeUnsafe("turn-pi"));
    expect(next.threads[0]?.session?.reason).toBe("turn.completed.awaiting_agent_end");
  });

  it("preserves running session updates without an active turn id", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          sessionEpoch: 0,
          reason: "context.compacting",
          lastError: null,
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
      }),
    );

    expect(next.threads[0]?.session?.status).toBe("running");
    expect(next.threads[0]?.session?.orchestrationStatus).toBe("running");
    expect(next.threads[0]?.session?.activeTurnId).toBeUndefined();
    expect(next.threads[0]?.latestTurn).toBeNull();
  });
});
