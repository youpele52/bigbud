import { EventId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvent } from "./events.store";
import { mapSession } from "./mappers.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

describe("provider orchestration updates", () => {
  it("preserves cliProxy as the mapped session provider", () => {
    const thread = makeThread({
      modelSelection: { provider: "cliProxy", model: "gpt-5.6-sol" },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "ready",
          providerName: "cliProxy",
          runtimeMode: "full-access",
          activeTurnId: null,
          reason: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
      }),
    );

    expect(next.threads[0]?.session?.provider).toBe("cliProxy");
  });

  it("maps unknown provider names to an explicit non-routable state", () => {
    const mapped = mapSession({
      threadId: "thread-1" as never,
      status: "ready",
      providerName: "futureProvider",
      runtimeMode: "full-access",
      activeTurnId: null,
      reason: null,
      lastError: null,
      updatedAt: "2026-02-27T00:00:02.000Z",
    });

    expect(mapped?.provider).toBe("unknown");
  });

  it("projects durable turn start failures and releases busy state", () => {
    const thread = makeThread({
      session: {
        provider: "cliProxy",
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: "turn-1" as never,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      },
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-start-failed", {
        threadId: thread.id,
        context: "provider-turn-start",
        detail: "Provider turn start failed.",
        createdAt: "2026-02-27T00:00:02.000Z",
      }),
    );

    expect(next.threads[0]?.session).toMatchObject({
      status: "error",
      orchestrationStatus: "error",
      activeTurnId: undefined,
    });
    expect(next.threads[0]?.latestTurn?.state).toBe("error");
    expect(next.threads[0]?.error).toBe("Provider turn start failed.");
  });

  it("surfaces provider turn start failures as thread errors", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.activity-appended", {
        threadId: thread.id,
        activity: {
          id: EventId.makeUnsafe("activity-provider-failure"),
          tone: "error",
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          payload: {
            detail: "Thread cannot switch to 'codex' while bound to 'cliProxy'.",
          },
          turnId: null,
          createdAt: "2026-02-27T00:00:02.000Z",
        },
      }),
    );

    expect(next.threads[0]?.error).toBe(
      "Thread cannot switch to 'codex' while bound to 'cliProxy'.",
    );
    expect(next.threads[0]?.activities).toHaveLength(1);
  });
});
