import type { ToolInvocation } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";

import { createCopilotThreadOrchestrationTools } from "./copilotThreadOrchestrationTools.ts";
import { COMPUTER_USE_TOOL_DESCRIPTION } from "./orchestrationComputerUseTool.shared.ts";
import { BROWSER_TOOL_DESCRIPTION } from "./orchestrationBrowserTool.shared.ts";
import {
  BIGBUD_PLAN_TRACKING_TOOL_DESCRIPTION,
  BIGBUD_PLAN_TRACKING_TOOL_NAME,
} from "./threadPlanTrackingTool.shared.ts";

const INVOCATION = {} as ToolInvocation;

function makeTools(
  overrides: Partial<Parameters<typeof createCopilotThreadOrchestrationTools>[0]> = {},
) {
  return createCopilotThreadOrchestrationTools({
    renameThread: async () => ({ title: "Renamed" }),
    archiveThread: async () => undefined,
    getThreadStatus: async () => ({ workflowStatus: "idle" }),
    listPinnedThreads: async () => ({ count: 0, threads: [] }),
    setThreadPinned: async (threadId, pinned) => ({ threadId, pinned }),
    browser: async () => ({ action: "capture", summary: "Captured." }),
    computerUse: async () => ({ surface: "desktop", action: "list_apps", summary: "ok" }),
    createThread: async () => ({ accepted: true }),
    ...overrides,
  });
}

describe("createCopilotThreadOrchestrationTools", () => {
  it("registers computer_use alongside thread orchestration tools", () => {
    const tools = makeTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "rename_thread",
      "archive_thread",
      "create_thread",
      "list_pinned_threads",
      "pin_thread",
      "unpin_thread",
      BIGBUD_PLAN_TRACKING_TOOL_NAME,
      "browser",
      "computer_use",
      "get_thread_status",
    ]);
    expect(tools.find((tool) => tool.name === "computer_use")?.description).toBe(
      COMPUTER_USE_TOOL_DESCRIPTION,
    );
    expect(tools.find((tool) => tool.name === "browser")?.description).toBe(
      BROWSER_TOOL_DESCRIPTION,
    );
    expect(tools.find((tool) => tool.name === BIGBUD_PLAN_TRACKING_TOOL_NAME)?.description).toBe(
      BIGBUD_PLAN_TRACKING_TOOL_DESCRIPTION,
    );
    expect(tools.find((tool) => tool.name === "pin_thread")?.description).toContain(
      "Only use this when the user explicitly asks to pin a thread.",
    );
    expect(tools.find((tool) => tool.name === "unpin_thread")?.description).toContain(
      "Only use this when the user explicitly asks to unpin a thread.",
    );
  });

  it("forwards decoded computer_use actions to the dispatcher", async () => {
    const computerUse = vi.fn(async () => ({
      surface: "desktop",
      action: "list_apps",
      summary: "Listed apps.",
    }));

    const computerUseTool = makeTools({ computerUse });
    const result = await computerUseTool
      .find((tool) => tool.name === "computer_use")
      ?.handler?.({ action: "list_apps" }, INVOCATION);

    expect(computerUse).toHaveBeenCalledWith({ action: "list_apps" });
    expect(result).toMatchObject({
      resultType: "success",
      textResultForLlm: expect.stringContaining("Listed apps."),
    });
  });

  it("returns a failure result when computer_use action decoding fails", async () => {
    const computerUseTool = makeTools();
    const result = await computerUseTool
      .find((tool) => tool.name === "computer_use")
      ?.handler?.({ action: "not-a-real-action" }, INVOCATION);

    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: expect.stringContaining("not-a-real-action"),
    });
  });

  it("creates a thread using the SDK tool-call ID for both bridge bindings", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tools = makeTools({
      createThread: async (input) => {
        calls.push(input);
        return { accepted: true };
      },
    });
    const tool = tools.find((candidate) => candidate.name === "create_thread");

    expect(tool?.handler).toBeDefined();
    if (!tool?.handler) return;

    const result = await tool.handler(
      {
        title: " Side chat ",
        task: " Investigate this ",
        projectId: " project-1 ",
        watchForCompletion: true,
      },
      {
        sessionId: "session-1",
        toolCallId: "copilot-tool-call-1",
        toolName: "create_thread",
        arguments: {},
      },
    );

    expect(result).toEqual({
      textResultForLlm: '{\n  "accepted": true\n}',
      resultType: "success",
      sessionLog: '{\n  "accepted": true\n}',
    });
    expect(calls).toEqual([
      {
        invocationId: "copilot-tool-call-1",
        sourceMessageId: "copilot-tool-call-1",
        title: "Side chat",
        task: "Investigate this",
        projectId: "project-1",
        watchForCompletion: true,
      },
    ]);
  });
});
