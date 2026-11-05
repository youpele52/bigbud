import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerManager } from "../../../codex/codexAppServerManager.ts";
import { exactRewindInput } from "../../../codex/codexAppServerManager.reliability.test.helpers.ts";
import { makeCodexInspectActiveTurn } from "./Adapter.inspection.ts";

describe("Codex durable item mapping", () => {
  it("uses the normal completed-plan handler for a lost final plan", async () => {
    const manager = {
      listSessions: () => [{ threadId: exactRewindInput.threadId, sessionEpoch: 2 }],
      inspectActiveTurn: async () => ({
        status: "completed",
        observedAt: "2026-10-30T11:00:00Z",
        turn: {
          id: "t2",
          completedAt: "2026-10-30T10:00:00.000Z",
          items: [{ id: "native-plan", type: "plan", text: "## Exact plan\n- build it" }],
        },
      }),
    } as unknown as CodexAppServerManager;
    const result = await Effect.runPromise(
      makeCodexInspectActiveTurn(manager)(
        exactRewindInput.threadId,
        exactRewindInput.expectedTurnIds[1]!,
      ),
    );
    expect(result.reconciliationEvents).toHaveLength(1);
    expect(result.reconciliationEvents?.[0]).toMatchObject({
      type: "turn.proposed.completed",
      itemId: "native-plan",
      createdAt: "2026-10-30T10:00:00.000Z",
      payload: { planMarkdown: "## Exact plan\n- build it" },
    });
    expect(result.terminalEvent).toMatchObject({
      type: "turn.completed",
      payload: { state: "completed", recoveryRedelivery: true },
      createdAt: "2026-10-30T10:00:00.000Z",
    });
    expect(result.terminalEvent?.payload.usage).toBeUndefined();
  });
  it("keeps original item IDs and stable command identity without replaying text deltas or usage", async () => {
    const inspectActiveTurn = vi.fn(async () => ({
      status: "completed",
      observedAt: new Date().toISOString(),
      turn: {
        id: "t2",
        completedAt: "2026-10-30T10:00:00.000Z",
        items: [{ id: "original-item", type: "agentMessage", text: "durable final text" }],
      },
    }));
    const manager = {
      listSessions: () => [{ threadId: exactRewindInput.threadId, sessionEpoch: 2 }],
      inspectActiveTurn,
    } as unknown as CodexAppServerManager;
    const inspect = makeCodexInspectActiveTurn(manager);
    const first = await Effect.runPromise(
      inspect(exactRewindInput.threadId, exactRewindInput.expectedTurnIds[1]!),
    );
    const second = await Effect.runPromise(
      inspect(exactRewindInput.threadId, exactRewindInput.expectedTurnIds[1]!),
    );
    expect(first.reconciliationEvents).toEqual(second.reconciliationEvents);
    expect(first.reconciliationEvents).toHaveLength(1);
    expect(first.reconciliationEvents?.[0]).toMatchObject({
      type: "item.completed",
      turnId: "t2",
      itemId: "original-item",
      sessionEpoch: 2,
      createdAt: "2026-10-30T10:00:00.000Z",
      payload: { itemType: "assistant_message", detail: "durable final text" },
    });
  });
});
