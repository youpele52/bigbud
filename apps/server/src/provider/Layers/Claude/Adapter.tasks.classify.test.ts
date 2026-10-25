import { describe, expect, it } from "vitest";

import { isClaudeProviderSubagent, resolveClaudeSubagentModel } from "./Adapter.tasks.classify.ts";
import type { ClaudeTask } from "./Adapter.tasks.types.ts";

const task = (overrides: Partial<ClaudeTask> = {}) => ({ ...overrides }) as ClaudeTask;

describe("Claude task classification", () => {
  it.each(["local_agent", "remote_agent", "agent", " local_agent "])(
    "classifies %s as a provider subagent",
    (taskType) => {
      expect(isClaudeProviderSubagent(task({ taskType }), true)).toBe(true);
    },
  );

  it.each(["local_bash", "local_workflow", "mcp_task", "monitor_mcp", "Local_Agent", undefined])(
    "keeps %s an ordinary task",
    (taskType) => {
      expect(isClaudeProviderSubagent(task({ taskType }), true)).toBe(false);
    },
  );

  it("keeps ambient agents and every unsupported-harness task ordinary", () => {
    expect(isClaudeProviderSubagent(task({ taskType: "local_agent", ambient: true }), true)).toBe(
      false,
    );
    expect(isClaudeProviderSubagent(task({ taskType: "local_agent" }), false)).toBe(false);
  });

  it("resolves the model by input, definition, observed, then resolved", () => {
    const models = new Map([
      ["Explore", "haiku"],
      ["general-purpose", "inherit"],
    ]);
    const all = task({
      subagentType: "Explore",
      requestedModel: "opus",
      observedModel: "claude-sonnet",
      resolvedModel: "claude-haiku",
    });
    expect(resolveClaudeSubagentModel(all, models)).toBe("opus");
    expect(resolveClaudeSubagentModel({ ...all, requestedModel: undefined }, models)).toBe("haiku");
    expect(
      resolveClaudeSubagentModel(
        { ...all, requestedModel: undefined, subagentType: "general-purpose" },
        models,
      ),
    ).toBe("claude-sonnet");
    expect(resolveClaudeSubagentModel(task({ resolvedModel: "claude-haiku" }), undefined)).toBe(
      "claude-haiku",
    );
    expect(resolveClaudeSubagentModel(task(), models)).toBeUndefined();
  });
});
