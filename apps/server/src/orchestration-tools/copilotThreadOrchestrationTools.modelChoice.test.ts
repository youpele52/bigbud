import { describe, expect, it, vi } from "vitest";

import { createCopilotThreadOrchestrationTools } from "./copilotThreadOrchestrationTools.ts";
import {
  CREATE_THREAD_TOOL_PARAMETERS,
  LIST_AVAILABLE_MODELS_PARAMETERS,
  LIST_AVAILABLE_MODELS_TOOL_DESCRIPTION,
} from "./threadOrchestrationBridge.shared.ts";

const invocation = (toolCallId: string, toolName: string) => ({
  sessionId: "session-1",
  toolCallId,
  toolName,
  arguments: {},
});

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

describe("Copilot thread tools: delegated model choice", () => {
  it("uses the shared create_thread schema and registers list_available_models", () => {
    const tools = makeTools();
    expect(tools.find((tool) => tool.name === "create_thread")?.parameters).toEqual(
      CREATE_THREAD_TOOL_PARAMETERS,
    );
    expect(tools.find((tool) => tool.name === "list_available_models")).toMatchObject({
      description: LIST_AVAILABLE_MODELS_TOOL_DESCRIPTION,
      parameters: LIST_AVAILABLE_MODELS_PARAMETERS,
    });
  });

  it("passes the raw modelSelection through only when given", async () => {
    const createThread = vi.fn(async (_input: Record<string, unknown>) => ({ accepted: true }));
    const tool = makeTools({ createThread }).find(
      (candidate) => candidate.name === "create_thread",
    );
    const modelSelection = { provider: "claudeAgent", model: "claude-sonnet" };
    await tool?.handler?.(
      { title: "Side", task: "Do it", modelSelection },
      invocation("call-1", "create_thread"),
    );
    await tool?.handler?.({ title: "Plain", task: "Do it" }, invocation("call-2", "create_thread"));
    expect(createThread).toHaveBeenNthCalledWith(1, expect.objectContaining({ modelSelection }));
    expect(createThread.mock.calls[1]?.[0]).not.toHaveProperty("modelSelection");
  });

  it("lists models through the dispatcher, or reports that listing is not ready", async () => {
    const listAvailableModels = vi.fn(async () => ({ models: [], hasMore: false }));
    const listTool = makeTools({ listAvailableModels }).find(
      (candidate) => candidate.name === "list_available_models",
    );
    const result = await listTool?.handler?.(
      { limit: 5 },
      invocation("call-3", "list_available_models"),
    );
    expect(listAvailableModels).toHaveBeenCalledWith({ limit: 5 });
    expect(result).toMatchObject({ resultType: "success" });

    const unready = await makeTools()
      .find((candidate) => candidate.name === "list_available_models")
      ?.handler?.({}, invocation("call-4", "list_available_models"));
    expect(unready).toMatchObject({ resultType: "failure", error: "Model listing is not ready." });
  });
});
