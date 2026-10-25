import { ThreadId, TurnId } from "@bigbud/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCodexThreadOrchestrationDynamicToolHandler,
  createCodexThreadOrchestrationDynamicTools,
} from "./codexThreadDynamicTools.ts";
import {
  setThreadOrchestrationToolDispatcher,
  type ThreadOrchestrationToolDispatcherShape,
} from "./ThreadOrchestrationToolDispatcher.ts";
import {
  CREATE_THREAD_TOOL_DESCRIPTION,
  CREATE_THREAD_TOOL_PARAMETERS,
  CREATE_THREAD_WITH_MODEL_CHOICE_TOOL_DESCRIPTION,
  LIST_AVAILABLE_MODELS_PARAMETERS,
  LIST_AVAILABLE_MODELS_TOOL_DESCRIPTION,
} from "./threadOrchestrationBridge.shared.ts";

const listResult = {
  parentModel: { provider: "codex", model: "gpt-5" },
  agentModelChoice: "agent" as const,
  models: [],
  hasMore: false,
};

describe("Codex dynamic tools: delegated model choice", () => {
  afterEach(() => setThreadOrchestrationToolDispatcher(null));

  it("uses the shared create_thread schema and adds list_available_models when opted in", () => {
    const tools = createCodexThreadOrchestrationDynamicTools({ delegatedModelChoice: true });
    expect(tools.find((tool) => tool.name === "create_thread")).toMatchObject({
      description: CREATE_THREAD_WITH_MODEL_CHOICE_TOOL_DESCRIPTION,
      inputSchema: CREATE_THREAD_TOOL_PARAMETERS,
    });
    expect(tools.find((tool) => tool.name === "list_available_models")).toMatchObject({
      namespace: "bigbud_orchestration",
      description: LIST_AVAILABLE_MODELS_TOOL_DESCRIPTION,
      inputSchema: LIST_AVAILABLE_MODELS_PARAMETERS,
    });
  });

  it("keeps the v1 surface frozen in OpenCode V2's bootstrap ABI by default", () => {
    const tools = createCodexThreadOrchestrationDynamicTools();
    const create = tools.find((tool) => tool.name === "create_thread");
    expect(create?.description).toBe(CREATE_THREAD_TOOL_DESCRIPTION);
    expect(JSON.stringify(create?.inputSchema)).not.toContain("modelSelection");
    expect(tools.some((tool) => tool.name === "list_available_models")).toBe(false);
  });

  it("passes the raw modelSelection through and lists models", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const dispatcher: Partial<ThreadOrchestrationToolDispatcherShape> = {
      createThread: (input) => {
        calls.push({ kind: "create", ...input });
        return Effect.succeed({
          accepted: true as const,
          replayed: false as const,
          childThreadId: ThreadId.makeUnsafe("child"),
          childTurnId: TurnId.makeUnsafe("child-turn"),
          createSequence: 1,
          turnSequence: 2,
          watchForCompletion: false,
          observedStatus: null,
        });
      },
      listAvailableModels: (input) => {
        calls.push({ kind: "list", ...input });
        return Effect.succeed(listResult as never);
      },
    };
    setThreadOrchestrationToolDispatcher(dispatcher as ThreadOrchestrationToolDispatcherShape);
    const handler = createCodexThreadOrchestrationDynamicToolHandler(ThreadId.makeUnsafe("parent"));

    // Malformed requests reach the server untouched; it falls back instead of failing.
    const modelSelection = { provider: 42, model: "claude-sonnet" };
    await handler({
      namespace: "bigbud_orchestration",
      tool: "create_thread",
      requestId: 1,
      arguments: { title: "Side", task: "Do it", modelSelection },
    });
    await handler({
      namespace: "bigbud_orchestration",
      tool: "create_thread",
      requestId: 2,
      arguments: { title: "Plain", task: "Do it" },
    });
    const listed = await handler({
      namespace: "bigbud_orchestration",
      tool: "list_available_models",
      requestId: 3,
      arguments: { limit: 5 },
    });

    expect(calls[0]).toMatchObject({ kind: "create", modelSelection });
    expect(calls[1]).not.toHaveProperty("modelSelection");
    expect(calls[2]).toEqual({ kind: "list", callerThreadId: "parent", limit: 5 });
    expect(listed.success).toBe(true);
    expect(listed.contentItems[0]).toMatchObject({ text: expect.stringContaining('"hasMore"') });
  });
});
