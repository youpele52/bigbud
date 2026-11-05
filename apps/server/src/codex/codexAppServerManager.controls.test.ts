import { describe, expect, it, vi } from "vitest";
import {
  codexReliabilityHarness,
  exactRewindInput,
} from "./codexAppServerManager.reliability.test.helpers.ts";
import { codexProviderControls } from "./codexAppServerManager.controls.ts";
import { compactBlocksWork, observeManualCompact } from "./codexAppServerManager.controls.state.ts";
import { confirmCodexCompaction } from "./codexAppServerManager.controls.state.ts";
import { CodexRpcError } from "./codexAppServerManager.errors.ts";
import type { ProviderControlsInput } from "@bigbud/contracts/server/providerControls";
import type { TurnOps } from "./codexAppServerManager.turn.ts";
import { sendTurn } from "./codexAppServerManager.turn.ts";
import { handleServerNotification } from "./codexAppServerManager.handlers.notification.ts";
import { readCodexThreadHistory } from "./codexAppServerManager.history.ts";

function harness() {
  const test = codexReliabilityHarness();
  const base = test.ops.sendRequest;
  let current = true;
  const mutation = vi.fn(async () => ({}));
  const sendRequest = vi.fn(
    async (...[context, method, params, timeout, guard]: Parameters<TurnOps["sendRequest"]>) => {
      if (method === "thread/read") return base(context, method, params, timeout);
      if (guard && !guard()) throw new CodexRpcError(method, 2, "not-dispatched", "stale");
      return (await mutation()) as never;
    },
  ) as TurnOps["sendRequest"];
  const ops = { ...test.ops, sendRequest };
  const run = (action: ProviderControlsInput["action"] = "compact", sessionEpoch = 2) =>
    codexProviderControls(
      test.context,
      { threadId: exactRewindInput.threadId, sessionEpoch, action },
      ops,
      () => current,
    );
  const notify = (method: string, extra: Record<string, unknown> = {}) =>
    observeManualCompact(test.context, {
      method,
      params: { threadId: "native", turnId: "maintenance", ...extra },
    });
  return {
    ...test,
    ops,
    run,
    notify,
    mutation,
    replace: () => {
      current = false;
    },
  };
}

describe("native Codex session controls", () => {
  it.each(["0.164.0", "0.166.0"])("advertises only pinned %s session support", async (version) => {
    const test = harness();
    test.context.runtimeVersion = version;
    const result = await test.run("status");
    expect(result.compact.available).toBe(true);
    expect(result.mcpStatus.available).toBe(true);
    expect(result.mcpReload.available).toBe(true);
    expect(result.mcpTargeted.available).toBe(false);
    expect(test.mutation).not.toHaveBeenCalled();
  });
  it("invalidates a history page already in flight when compact is accepted", async () => {
    const test = harness();
    const original = test.ops.sendRequest;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    test.ops.sendRequest = async (ctx, method, params, timeout, guard) => {
      if (method === "thread/turns/list") {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { data: [], nextCursor: null } as never;
      }
      return original(ctx, method, params, timeout, guard) as never;
    };
    const history = readCodexThreadHistory(test.context, test.ops);
    await waiting;
    await test.run();
    release();
    await expect(history).rejects.toThrow("changed during the read");
  });
  it("allows late native completion to settle an uncertain submission without resending", async () => {
    const test = harness();
    test.mutation.mockRejectedValue(
      new CodexRpcError("thread/compact/start", 2, "possibly-applied", "disconnect"),
    );
    expect((await test.run()).compactState).toBe("unknown");
    test.notify("item/started", { item: { id: "compact", type: "contextCompaction" } });
    test.notify("item/completed", { item: { id: "compact", type: "contextCompaction" } });
    test.notify("turn/completed", { turn: { id: "maintenance", status: "completed" } });
    expect((await test.run("status")).compactState).toBe("working");
    expect(
      confirmCodexCompaction(test.context, {
        threadId: exactRewindInput.threadId,
        sessionEpoch: 2,
        nativeThreadId: "native",
        turnId: "maintenance",
        itemId: "compact",
      }),
    ).toBe(true);
    expect((await test.run("status")).compactState).toBe("completed");
    expect(test.mutation).toHaveBeenCalledTimes(1);
  });
  it("does not infer compaction success from a completed turn without the actual item lifecycle", async () => {
    const test = harness();
    await test.run();
    test.notify("turn/started", { turn: { id: "maintenance" } });
    test.notify("turn/completed", { turn: { id: "maintenance", status: "completed" } });
    expect((await test.run("status")).compactState).toBe("unknown");
    expect(compactBlocksWork(test.context)).toBe(true);
    expect(test.mutation).toHaveBeenCalledTimes(1);
  });
  it("derives the native thread and never treats RPC acknowledgment as completion", async () => {
    const test = harness();
    const result = await test.run();
    expect(result.compactState).toBe("submitted");
    expect(test.ops.sendRequest).toHaveBeenCalledWith(
      test.context,
      "thread/compact/start",
      { threadId: "native" },
      20_000,
      expect.any(Function),
    );
    expect(test.context.historyGeneration).toBe(1);
    expect(result.mcpTargeted.available).toBe(false);
    test.notify("item/completed", { item: { id: "unseen", type: "contextCompaction" } });
    expect(test.context.manualCompact?.state).toBe("submitted");
    test.notify("item/started", { item: { id: "compact", type: "contextCompaction" } });
    expect(test.context.manualCompact?.state).toBe("working");
    test.notify("item/completed", {
      threadId: "other",
      item: { id: "compact", type: "contextCompaction" },
    });
    test.notify("item/completed", { item: { id: "other", type: "contextCompaction" } });
    expect(test.context.manualCompact?.state).toBe("working");
    test.notify("item/completed", { item: { id: "compact", type: "contextCompaction" } });
    expect(compactBlocksWork(test.context)).toBe(true);
    test.notify("turn/completed", { turn: { id: "maintenance", status: "completed" } });
    expect(compactBlocksWork(test.context)).toBe(true);
    expect(
      confirmCodexCompaction(test.context, {
        threadId: exactRewindInput.threadId,
        sessionEpoch: 2,
        nativeThreadId: "native",
        turnId: "maintenance",
        itemId: "compact",
      }),
    ).toBe(true);
    expect((await test.run("status")).compactState).toBe("completed");
    expect(test.context.historyGeneration).toBe(2);
  });

  it.each(["0.100.0", "0.165.0", "0.166.1", undefined])(
    "disables unqualified runtime %s",
    async (version) => {
      const test = harness();
      test.context.runtimeVersion = version;
      expect((await test.run("status")).compact.available).toBe(false);
      await expect(test.run()).rejects.toThrow("Requires Codex");
      expect(test.mutation).not.toHaveBeenCalled();
    },
  );
  it.each(["legacy", "unknown", "ephemeral"])(
    "disables unqualified native mode %s",
    async (mode) => {
      const test = harness();
      if (mode === "ephemeral") test.state.thread.ephemeral = true;
      else test.state.thread.historyMode = mode;
      expect((await test.run("status")).mcpStatus.available).toBe(false);
      await expect(test.run("reload-mcp")).rejects.toThrow();
      expect(test.mutation).not.toHaveBeenCalled();
    },
  );
  it.each(["turn", "approval", "input", "tool", "child", "pending", "native"])(
    "blocks %s activity without mutation",
    async (activity) => {
      const test = harness();
      if (activity === "turn")
        test.context.session = {
          ...test.context.session,
          activeTurnId: exactRewindInput.expectedTurnIds[0],
        };
      if (activity === "approval")
        test.context.pendingApprovals.set("request" as never, {} as never);
      if (activity === "input") test.context.pendingUserInputs.set("request" as never, {} as never);
      if (activity === "tool") test.context.pendingToolCalls = 1;
      if (activity === "child")
        test.context.collabChildTurns.set("child", exactRewindInput.expectedTurnIds[0]!);
      if (activity === "pending") test.context.pending.set("rpc", {} as never);
      if (activity === "native") test.state.thread.status.type = "active";
      await expect(test.run()).rejects.toThrow();
      await expect(test.run("reload-mcp")).rejects.toThrow();
      expect(test.mutation).not.toHaveBeenCalled();
    },
  );
  it("checks epoch before any native access", async () => {
    const test = harness();
    await expect(test.run("compact", 1)).rejects.toThrow("changed");
    expect(test.ops.sendRequest).not.toHaveBeenCalled();
  });
  it.each(["epoch", "stop", "replace", "interaction", "generation"])(
    "fences %s after asynchronous preflight",
    async (change) => {
      const test = harness();
      const original = test.ops.sendRequest;
      test.ops.sendRequest = async (ctx, method, params, timeout, guard) => {
        const response = await original(ctx, method, params, timeout, guard);
        if (method === "thread/read") {
          if (change === "epoch") ctx.session = { ...ctx.session, sessionEpoch: 3 };
          if (change === "stop") ctx.stopping = true;
          if (change === "replace") test.replace();
          if (change === "interaction") ctx.pendingUserInputs.set("request" as never, {} as never);
          if (change === "generation") ctx.historyGeneration = 5;
        }
        return response as never;
      };
      await expect(test.run()).rejects.toThrow();
      expect(test.mutation).not.toHaveBeenCalled();
    },
  );
  it("rejects duplicate compact and reload while waiting for a lifecycle, including after timeout", async () => {
    const test = harness();
    await test.run();
    test.context.manualCompact!.deadline = Date.now() - 1;
    expect((await test.run("status")).compactState).toBe("unknown");
    await expect(test.run()).rejects.toThrow("pending");
    await expect(test.run("reload-mcp")).rejects.toThrow("pending");
    expect(test.mutation).toHaveBeenCalledTimes(1);
    await expect(
      sendTurn({ threadId: exactRewindInput.threadId, input: "hi" }, test.context, test.ops),
    ).rejects.toThrow("uncertain");
  });
  it.each(["not-dispatched", "possibly-applied"] as const)(
    "never resends a %s error",
    async (delivery) => {
      const test = harness();
      test.mutation.mockRejectedValue(
        new CodexRpcError("thread/compact/start", 2, delivery, "private"),
      );
      const result = await test.run();
      expect(result.compactState).toBe(delivery === "not-dispatched" ? "failed" : "unknown");
      expect(result.message).not.toContain("private");
      expect(test.mutation).toHaveBeenCalledTimes(1);
    },
  );
  it("records native failure and suppresses maintenance turn publication, not ordinary user events", async () => {
    const test = harness();
    await test.run();
    const emitEvent = vi.fn();
    handleServerNotification(
      test.context,
      { method: "turn/started", params: { threadId: "native", turn: { id: "maintenance" } } },
      { emitEvent, updateSession: vi.fn() },
    );
    handleServerNotification(
      test.context,
      {
        method: "turn/completed",
        params: { threadId: "native", turn: { id: "maintenance", status: "failed" } },
      },
      { emitEvent, updateSession: vi.fn() },
    );
    expect(test.context.manualCompact?.state).toBe("failed");
    expect(emitEvent).not.toHaveBeenCalled();
    expect(compactBlocksWork(test.context)).toBe(false);
  });
});
