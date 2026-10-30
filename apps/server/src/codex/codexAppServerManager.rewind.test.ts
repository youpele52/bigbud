import { describe, expect, it } from "vitest";
import { TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { CodexRpcError } from "./codexAppServerManager.errors.ts";
import { prepareCodexRewind, revertCodexThread } from "./codexAppServerManager.rewind.ts";
import {
  codexReliabilityHarness,
  exactRewindInput,
} from "./codexAppServerManager.reliability.test.helpers.ts";

describe("Codex exact rewind", () => {
  it("excludes the exact first removed turn and rehydrates the retained prefix", async () => {
    const { context, ops, sendRequest } = codexReliabilityHarness();
    const result = await revertCodexThread(context, exactRewindInput, ops);
    expect(result.turns.map((turn) => turn.id)).toEqual(["t1"]);
    expect(
      sendRequest.mock.calls.filter((call) => call[1] === "thread/revert").map((call) => call[2]),
    ).toEqual([{ threadId: "native", beforeTurnId: "t2" }]);
    expect(sendRequest.mock.calls.some((call) => call[1] === "thread/rollback")).toBe(false);
  });

  it.each([0, 2])("supports verified all/no-op boundaries at %i", async (targetTurnCount) => {
    const { context, ops, sendRequest } = codexReliabilityHarness();
    const input = {
      ...exactRewindInput,
      targetTurnCount,
      retainedTurnId: exactRewindInput.expectedTurnIds[targetTurnCount - 1] ?? null,
      firstRemovedTurnId: exactRewindInput.expectedTurnIds[targetTurnCount] ?? null,
    };
    expect((await revertCodexThread(context, input, ops)).turns).toHaveLength(targetTurnCount);
    expect(sendRequest.mock.calls.filter((call) => call[1] === "thread/revert")).toHaveLength(
      targetTurnCount === 2 ? 0 : 1,
    );
  });

  it.each([
    "prefix",
    "gap",
    "duplicate",
    "ordering",
    "thread",
    "legacy",
    "ephemeral",
    "pending",
    "running",
  ])("rejects %s before mutation", async (fault) => {
    const { context, state, ops, sendRequest } = codexReliabilityHarness();
    if (fault === "prefix") state.turns.unshift({ ...state.turns[0]!, id: "imported" });
    if (fault === "gap") state.turns.pop();
    if (fault === "duplicate") state.turns[1]!.id = "t1";
    if (fault === "ordering") state.turns.reverse();
    if (fault === "thread") state.thread.id = "other";
    if (fault === "legacy") state.thread.historyMode = "legacy";
    if (fault === "ephemeral") state.thread.ephemeral = true;
    if (fault === "pending") context.pending.set("request", {} as never);
    if (fault === "running")
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: TurnId.makeUnsafe("t2"),
      };
    await expect(revertCodexThread(context, exactRewindInput, ops)).rejects.toThrow();
    expect(sendRequest.mock.calls.some((call) => call[1] === "thread/revert")).toBe(false);
  });

  it.each([-1, 3, 0.5])("rejects invalid target %s", async (targetTurnCount) => {
    const { context, ops } = codexReliabilityHarness();
    await expect(
      prepareCodexRewind(context, { ...exactRewindInput, targetTurnCount }, ops),
    ).rejects.toThrow();
  });

  it("rejects a missing checkpoint boundary ID", async () => {
    const { context, ops } = codexReliabilityHarness();
    await expect(
      prepareCodexRewind(context, { ...exactRewindInput, firstRemovedTurnId: null }, ops),
    ).rejects.toThrow("boundary");
  });

  it("verifies storage after commit-then-RPC-error without issuing a second mutation", async () => {
    const { context, state, ops, sendRequest } = codexReliabilityHarness();
    const normal = sendRequest.getMockImplementation()!;
    sendRequest.mockImplementation(async (ctx, method, params) => {
      const result = await normal(ctx, method, params);
      if (method === "thread/revert")
        throw new CodexRpcError(method, 2, "possibly-applied", "reload failed");
      return result;
    });
    expect((await revertCodexThread(context, exactRewindInput, ops)).turns).toHaveLength(1);
    expect(state.turns).toHaveLength(1);
    expect(sendRequest.mock.calls.filter((call) => call[1] === "thread/revert")).toHaveLength(1);
  });

  it("rejects changed metadata and interactions arriving during preflight", async () => {
    const { context, state, ops, sendRequest } = codexReliabilityHarness();
    const normal = sendRequest.getMockImplementation()!;
    sendRequest.mockImplementation(async (ctx, method, params) => {
      const result = await normal(ctx, method, params);
      if (method === "thread/turns/list") {
        state.thread.updatedAt++;
        context.pendingApprovals.set("approval" as never, {} as never);
      }
      return result;
    });
    await expect(revertCodexThread(context, exactRewindInput, ops)).rejects.toThrow();
    expect(sendRequest.mock.calls.some((call) => call[1] === "thread/revert")).toBe(false);
  });

  it("does not treat a disconnected hydration as a successful revert", async () => {
    const { context, ops, sendRequest } = codexReliabilityHarness();
    const normal = sendRequest.getMockImplementation()!;
    sendRequest.mockImplementation(async (ctx, method, params) => {
      const result = await normal(ctx, method, params);
      if (method === "thread/revert") context.stopping = true;
      return result;
    });
    await expect(revertCodexThread(context, exactRewindInput, ops)).rejects.toThrow();
  });
});
