import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ThreadId } from "@bigbud/contracts";
import type { ToolInvocation } from "@github/copilot-sdk";
import {
  SYSTEM_RESOURCE_READ_PARAMETERS,
  SYSTEM_RESOURCE_RULE_PARAMETERS,
} from "./systemResourceTools.shared.ts";
import { createCodexThreadOrchestrationDynamicTools } from "./codexThreadDynamicTools.specs.ts";
import { createCodexThreadOrchestrationDynamicToolHandler } from "./codexThreadDynamicTools.ts";
import { createCopilotThreadOrchestrationTools } from "./copilotThreadOrchestrationTools.ts";
import {
  setThreadOrchestrationToolDispatcher,
  type ThreadOrchestrationToolDispatcherShape,
} from "./ThreadOrchestrationToolDispatcher.ts";
import { ORCHESTRATION_MCP_TOOL_DEFINITIONS } from "./orchestrationMcpBridge.template.shared.ts";
import { prepareV2OrchestrationRequest } from "../provider/Layers/OpencodeV2/Execution.orchestration.ts";

afterEach(() => setThreadOrchestrationToolDispatcher(null));
const readArgs = {
  view: "processes",
  limit: 20,
  cursor: { generation: 1, digest: "123", offset: 20 },
};
const mutation = { operation: "enable", enabled: false, expectedRevision: 4 };

it("shares read/mutation schemas across Codex, Copilot and generated MCP tools", () => {
  const codex = createCodexThreadOrchestrationDynamicTools();
  const copilot = createCopilotThreadOrchestrationTools({} as never);
  const mcp = runInNewContext(`${ORCHESTRATION_MCP_TOOL_DEFINITIONS.join("\n")}\nTOOLS`) as {
    name: string;
    inputSchema: unknown;
  }[];
  for (const [name, schema] of [
    ["get_system_resources", SYSTEM_RESOURCE_READ_PARAMETERS],
    ["configure_system_resource_rules", SYSTEM_RESOURCE_RULE_PARAMETERS],
  ] as const) {
    expect(codex.find((tool) => tool.name === name)?.inputSchema).toEqual(schema);
    expect(copilot.find((tool) => tool.name === name)?.parameters).toEqual(schema);
    expect(mcp.find((tool) => tool.name === name)?.inputSchema).toEqual(schema);
  }
});

it("forwards bounded arguments through Codex/Copilot and the canonical OpenCodeV2 route", async () => {
  const getSystemResources = vi.fn((_input?: unknown) => Effect.succeed({ available: true }));
  const configureSystemResourceRules = vi.fn((_input: unknown) =>
    Effect.succeed({ available: true }),
  );
  setThreadOrchestrationToolDispatcher({
    getSystemResources,
    configureSystemResourceRules,
  } as unknown as ThreadOrchestrationToolDispatcherShape);
  const codex = createCodexThreadOrchestrationDynamicToolHandler(
    ThreadId.makeUnsafe("resource-parity"),
  );
  await codex({
    namespace: "bigbud_orchestration",
    tool: "get_system_resources",
    arguments: readArgs,
    requestId: "read",
  } as never);
  await codex({
    namespace: "bigbud_orchestration",
    tool: "configure_system_resource_rules",
    arguments: mutation,
    requestId: "write",
  } as never);
  expect(getSystemResources).toHaveBeenCalledWith(readArgs);
  expect(configureSystemResourceRules).toHaveBeenCalledWith(mutation);
  const read = vi.fn(async (_args?: unknown) => ({ available: true }));
  const write = vi.fn(async (_args: unknown) => ({ available: true }));
  const copilot = createCopilotThreadOrchestrationTools({
    getSystemResources: read,
    configureSystemResourceRules: write,
  } as never);
  await copilot.find((tool) => tool.name === "get_system_resources")!.handler!(
    readArgs,
    {} as ToolInvocation,
  );
  await copilot.find((tool) => tool.name === "configure_system_resource_rules")!.handler!(
    mutation,
    {} as ToolInvocation,
  );
  expect(read).toHaveBeenCalledWith(readArgs);
  expect(write).toHaveBeenCalledWith(mutation);
  expect(
    prepareV2OrchestrationRequest({ action: "get_system_resources", resourceArguments: readArgs }, [
      "test",
    ]).resourceArguments,
  ).toEqual(readArgs);
  expect(
    prepareV2OrchestrationRequest(
      { action: "configure_system_resource_rules", resourceArguments: mutation },
      ["test"],
    ).resourceArguments,
  ).toEqual(mutation);
});
