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

describe("createCopilotThreadOrchestrationTools", () => {
  it("registers computer_use alongside thread orchestration tools", () => {
    const tools = createCopilotThreadOrchestrationTools({
      renameThread: async () => ({ title: "Renamed" }),
      archiveThread: async () => undefined,
      getThreadStatus: async () => ({ workflowStatus: "idle" }),
      browser: async () => ({ action: "capture", summary: "Captured." }),
      computerUse: async () => ({ surface: "desktop", action: "list_apps", summary: "ok" }),
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "rename_thread",
      "archive_thread",
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
  });

  it("forwards decoded computer_use actions to the dispatcher", async () => {
    const computerUse = vi.fn(async () => ({
      surface: "desktop",
      action: "list_apps",
      summary: "Listed apps.",
    }));

    const tools = createCopilotThreadOrchestrationTools({
      renameThread: async () => ({ title: "Renamed" }),
      archiveThread: async () => undefined,
      getThreadStatus: async () => ({ workflowStatus: "idle" }),
      browser: async () => ({ action: "capture", summary: "Captured." }),
      computerUse,
    });

    const computerUseTool = tools.find((tool) => tool.name === "computer_use");
    expect(computerUseTool).toBeDefined();

    const result = await computerUseTool?.handler?.({ action: "list_apps" }, INVOCATION);
    expect(computerUse).toHaveBeenCalledWith({ action: "list_apps" });
    expect(result).toMatchObject({
      resultType: "success",
      textResultForLlm: expect.stringContaining("Listed apps."),
    });
  });

  it("returns a failure result when computer_use action decoding fails", async () => {
    const tools = createCopilotThreadOrchestrationTools({
      renameThread: async () => ({ title: "Renamed" }),
      archiveThread: async () => undefined,
      getThreadStatus: async () => ({ workflowStatus: "idle" }),
      browser: async () => ({ action: "capture", summary: "Captured." }),
      computerUse: async () => ({}),
    });

    const computerUseTool = tools.find((tool) => tool.name === "computer_use");
    const result = await computerUseTool?.handler?.({ action: "not-a-real-action" }, INVOCATION);

    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: expect.stringContaining("not-a-real-action"),
    });
  });
});
