import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { rememberBoundedIdentity } from "./Adapter.dedup.ts";
import { claimNativeMessageId } from "./Adapter.session.runtime.ts";
import { reduceClaudeTaskState } from "./Adapter.tasks.reducer.ts";
import { makeClaudeTaskState } from "./Adapter.tasks.ts";

describe("Claude bounded deduplication", () => {
  it("evicts the oldest generic and native message identities", () => {
    const seen = new Set<string>();
    for (let index = 0; index <= 500; index += 1) {
      expect(rememberBoundedIdentity(seen, `queued-${index}`, 500)).toBe(true);
    }
    expect(seen).toHaveLength(500);
    expect(seen.has("queued-0")).toBe(false);

    const native = new Set<string>();
    for (let index = 0; index <= 1_000; index += 1) {
      expect(
        claimNativeMessageId(native, {
          type: "system",
          subtype: "status",
          uuid: `native-${index}`,
        } as SDKMessage),
      ).toBe(true);
    }
    expect(native).toHaveLength(1_000);
    expect(native.has("native-0:system:status")).toBe(false);
  });

  it("bounds task message and input fingerprints", () => {
    const state = makeClaudeTaskState();
    for (let index = 0; index <= 1_000; index += 1) {
      reduceClaudeTaskState({
        state,
        toolUseId: `tool-${index}`,
        toolName: "TaskGet",
        value: { uuid: `task-message-${index}`, task_id: `task-${index}` },
        updatedAt: "2026-07-26T00:00:00.000Z",
      });
    }
    expect(state.seenMessageIds).toHaveLength(1_000);
    expect(state.seenInputFingerprints).toHaveLength(1_000);
    expect(state.seenMessageIds.has("task-message-0")).toBe(false);
  });
});
