import { describe, expect, it } from "vitest";
import { EventId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { confirmCodexInspectedTurn, inspectCodexTurn } from "./codexAppServerManager.inspection.ts";
import { codexReliabilityHarness } from "./codexAppServerManager.reliability.test.helpers.ts";
import { asThreadId, createSendTurnHarness } from "./codexAppServerManager.test.helpers.ts";
import { validProviderPublication } from "../provider/providerPublication.ts";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";

const turnId = TurnId.makeUnsafe("t2");

describe("Codex exact native inspection", () => {
  it.each(["generation", "process", "turn"])(
    "revokes publication authority after a live native %s change without changing canonical ownership",
    async (change) => {
      const { context, ops } = codexReliabilityHarness();
      const event: ProviderRuntimeEvent = {
        eventId: EventId.makeUnsafe("guarded-terminal"),
        threadId: context.session.threadId,
        turnId,
        provider: "codex",
        sessionEpoch: 2,
        type: "turn.completed",
        createdAt: "2026-10-30T00:00:00Z",
        payload: { state: "completed", recoveryRedelivery: true },
      };
      let current = true;
      await inspectCodexTurn(context, turnId, ops);
      expect(
        confirmCodexInspectedTurn(context, turnId, 2, "completed", ops, event, () => current),
      ).toBe("confirmed");
      expect(validProviderPublication(event)).toBe(true);
      if (change === "generation") context.historyGeneration = (context.historyGeneration ?? 0) + 1;
      if (change === "process") current = false;
      if (change === "turn")
        context.session = {
          ...context.session,
          activeTurnId: TurnId.makeUnsafe("other-native-turn"),
        };
      expect(validProviderPublication(event)).toBe(false);
      expect(
        confirmCodexInspectedTurn(context, turnId, 2, "completed", ops, undefined, () => current),
      ).toBe("rejected");
    },
  );

  it("does not call a stopping but still live process absent", async () => {
    const { context, ops } = codexReliabilityHarness();
    await inspectCodexTurn(context, turnId, ops);
    context.stopping = true;
    expect(confirmCodexInspectedTurn(context, turnId, 2, "completed", ops)).toBe("rejected");
    Object.assign(context.child, { exitCode: 0 });
    expect(confirmCodexInspectedTurn(context, turnId, 2, "completed", ops)).toBe("absent");
  });
  it("does not resurrect a turn when its start acknowledgement follows its completion", async () => {
    const { manager, context, sendRequest, updateSession } = createSendTurnHarness();
    sendRequest.mockImplementationOnce(async () => {
      Object.assign(context, { completedTurnId: "turn_1" });
      return { turn: { id: "turn_1" } };
    });
    await manager.sendTurn({ threadId: asThreadId("thread_1"), input: "accepted once" });
    expect(updateSession).not.toHaveBeenCalledWith(
      context,
      expect.objectContaining({ status: "running" }),
    );
  });
  it.each(["completed", "failed"])("reports durable %s with exact final items", async (status) => {
    const { context, state, ops } = codexReliabilityHarness();
    state.turns[1]!.status = status;
    state.turns[1]!.items = [{ id: "final", type: "agentMessage", text: "complete output" }];
    const result = await inspectCodexTurn(context, turnId, ops);
    expect(result.status).toBe(status);
    expect(result.turn?.items).toEqual(state.turns[1]!.items);
  });

  it.each(["interrupted", "unknown", "inProgress"])(
    "does not infer terminal state from idle %s",
    async (status) => {
      const { context, state, ops } = codexReliabilityHarness();
      state.turns[1]!.status = status;
      expect((await inspectCodexTurn(context, turnId, ops)).status).toBe("unavailable");
    },
  );

  it("requires exact live ownership for running and correlated unresolved interactions", async () => {
    const { context, state, ops } = codexReliabilityHarness();
    state.turns[1]!.status = "inProgress";
    state.thread.status.type = "active";
    expect((await inspectCodexTurn(context, turnId, ops)).status).toBe("unavailable");
    context.session = { ...context.session, activeTurnId: turnId, status: "running" };
    expect((await inspectCodexTurn(context, turnId, ops)).status).toBe("running");
    context.pendingUserInputs.set(
      "request" as never,
      { nativeThreadId: "child", nativeTurnId: turnId, epoch: 2 } as never,
    );
    expect((await inspectCodexTurn(context, turnId, ops)).status).toBe("running");
    context.pendingUserInputs.set(
      "request" as never,
      {
        nativeThreadId: "native",
        nativeTurnId: turnId,
        epoch: 2,
        state: "response-sent-unconfirmed",
      } as never,
    );
    expect((await inspectCodexTurn(context, turnId, ops)).status).toBe("waiting-for-user");
  });

  it("reports missing only after a complete stable idle read", async () => {
    const { context, state, ops } = codexReliabilityHarness();
    state.turns.pop();
    expect((await inspectCodexTurn(context, turnId, ops)).status).toBe("missing");
    context.stopping = true;
    expect((await inspectCodexTurn(context, turnId, ops)).status).toBe("unavailable");
  });

  it("does not claim ownership after a resume, or invent a stable completion time", async () => {
    const { context, state, ops } = codexReliabilityHarness();
    context.ownedTurnId = undefined;
    expect((await inspectCodexTurn(context, turnId, ops)).status).toBe("unavailable");
    context.ownedTurnId = turnId;
    state.turns[1]!.completedAt = 0;
    expect((await inspectCodexTurn(context, turnId, ops)).status).toBe("unavailable");
  });

  it("keeps backend retry warnings nonterminal even if a history read looks failed", async () => {
    const { context, state, ops } = codexReliabilityHarness();
    context.retryingTurnId = turnId;
    state.turns[1]!.status = "failed";
    expect((await inspectCodexTurn(context, turnId, ops)).status).toBe("unavailable");
  });

  it("confirms reconciled output only for the inspected process generation and epoch", async () => {
    const { context, ops } = codexReliabilityHarness();
    expect(confirmCodexInspectedTurn(context, turnId, 2, "completed", ops)).toBe("rejected");
    await inspectCodexTurn(context, turnId, ops);
    expect(confirmCodexInspectedTurn(context, turnId, 2, "completed", ops)).toBe("confirmed");
    expect(confirmCodexInspectedTurn(context, turnId, 3, "completed", ops)).toBe("rejected");
    context.historyGeneration = (context.historyGeneration ?? 0) + 1;
    expect(confirmCodexInspectedTurn(context, turnId, 2, "completed", ops)).toBe("rejected");
    expect(confirmCodexInspectedTurn(undefined, turnId, 2, "completed", ops)).toBe("absent");
  });

  it("discards stale epoch, partial page, and foreign-thread reads", async () => {
    for (const fault of ["epoch", "page", "thread", "metadata"]) {
      const { context, state, ops, sendRequest } = codexReliabilityHarness();
      const normal = sendRequest.getMockImplementation()!;
      sendRequest.mockImplementation(async (ctx, method, params) => {
        const result = await normal(ctx, method, params);
        if (method === "thread/turns/list") {
          if (fault === "epoch") context.session = { ...context.session, sessionEpoch: 3 };
          if (fault === "page") return { data: [], nextCursor: "nonempty" };
          if (fault === "metadata") state.thread.updatedAt++;
        }
        return result;
      });
      if (fault === "thread") state.thread.id = "foreign";
      expect((await inspectCodexTurn(context, turnId, ops)).status).toBe("unavailable");
    }
  });
});
