import { describe, expect, it } from "vitest";

import { FakeClaudeQuery } from "./Adapter.test.helpers.ts";
import {
  CLAUDE_AGENT_SDK_VERSION,
  claudeSdkMessageDiscriminator,
  claudeSdkMessageLabel,
  type ClaudeInitializationResult,
} from "./Adapter.sdk.ts";

const initializationResponse: ClaudeInitializationResult = {
  commands: [],
  agents: [],
  output_style: "default",
  available_output_styles: [],
  models: [],
  account: {},
};

describe("Claude SDK compatibility boundary", () => {
  it("preserves typed interrupt receipts", async () => {
    const query = new FakeClaudeQuery();
    query.interruptResult = {
      still_queued: ["queued-message"],
      cancelled: ["cancelled-message"],
    };

    await expect(query.interrupt()).resolves.toEqual({
      still_queued: ["queued-message"],
      cancelled: ["cancelled-message"],
    });
    expect(query.interruptCalls).toHaveLength(1);
  });

  it("tracks recovery, MCP, and rewind controls", async () => {
    const query = new FakeClaudeQuery();
    query.setInitializationResponse(initializationResponse);
    query.mcpServerStatusesResult = [{ name: "docs", status: "pending" }];
    query.rewindFilesResult = { canRewind: true, filesChanged: ["README.md"] };
    query.setMcpServersResult = { added: ["docs"], removed: [], errors: {} };

    await expect(query.reinitialize()).resolves.toBe(initializationResponse);
    await expect(query.mcpServerStatus()).resolves.toEqual([{ name: "docs", status: "pending" }]);
    await expect(query.setMcpPermissionModeOverride("docs", "auto")).resolves.toEqual({});
    await query.reconnectMcpServer("docs");
    await query.toggleMcpServer("docs", false);
    await expect(query.setMcpServers({})).resolves.toEqual({
      added: ["docs"],
      removed: [],
      errors: {},
    });
    await expect(query.rewindFiles("user-message", { dryRun: true })).resolves.toEqual({
      canRewind: true,
      filesChanged: ["README.md"],
    });

    expect(query.reinitializeCalls).toHaveLength(1);
    expect(query.mcpServerStatusCalls).toHaveLength(1);
    expect(query.setMcpPermissionModeOverrideCalls).toEqual([{ serverName: "docs", mode: "auto" }]);
    expect(query.reconnectMcpServerCalls).toEqual(["docs"]);
    expect(query.toggleMcpServerCalls).toEqual([{ serverName: "docs", enabled: false }]);
    expect(query.setMcpServersCalls).toEqual([{}]);
    expect(query.rewindFilesCalls).toEqual([
      { userMessageId: "user-message", options: { dryRun: true } },
    ]);
  });

  it("injects deterministic control failures", async () => {
    const query = new FakeClaudeQuery();
    query.failControl("reinitialize", new Error("transport unavailable"));

    await expect(query.reinitialize()).rejects.toThrow("transport unavailable");
  });

  it("tracks model, permission, thinking, rewind, and close controls deterministically", async () => {
    const query = new FakeClaudeQuery();
    await query.setModel("claude-opus-4-6");
    await query.setPermissionMode("plan");
    await query.setMaxThinkingTokens(42, "summarized");
    await query.rewindFiles("user-message", { dryRun: false });
    query.close();

    expect(query.setModelCalls).toEqual(["claude-opus-4-6"]);
    expect(query.setPermissionModeCalls).toEqual(["plan"]);
    expect(query.setMaxThinkingTokensCalls).toEqual([[42, "summarized"]]);
    expect(query.rewindFilesCalls).toEqual([
      { userMessageId: "user-message", options: { dryRun: false } },
    ]);
    expect(query.closeCalls).toBe(1);
    await expect(query[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
  });

  it("settles pending iteration when close fails", async () => {
    const query = new FakeClaudeQuery();
    const pending = query[Symbol.asyncIterator]().next();
    query.failControl("close", new Error("close failed"));

    expect(() => query.close()).toThrow("close failed");
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it("builds safe SDK message discriminators", () => {
    expect(CLAUDE_AGENT_SDK_VERSION).toBe("0.3.219");
    expect(claudeSdkMessageDiscriminator({ type: "system", subtype: "task_updated" })).toEqual({
      type: "system",
      subtype: "task_updated",
    });
    expect(claudeSdkMessageLabel({ type: "system", subtype: "task_updated" })).toBe(
      "system/task_updated",
    );
    expect(claudeSdkMessageLabel(null)).toBe("object");
    expect(claudeSdkMessageLabel({})).toBe("unknown");
  });
});
