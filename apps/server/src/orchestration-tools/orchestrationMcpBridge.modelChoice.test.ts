import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createInvocationFixture, spawnBridge } from "./mcpInvocationIdentity.testSupport.ts";
import { buildClaudeOrchestrationBridgeConfig } from "./orchestrationMcpBridge.ts";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import {
  CREATE_THREAD_TOOL_PARAMETERS,
  LIST_AVAILABLE_MODELS_PARAMETERS,
} from "./threadOrchestrationBridge.shared.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

async function startBridge() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-mcp-model-choice-"));
  roots.push(root);
  const fixture = await createInvocationFixture(async (body) => ({
    result: body.action === "list_available_models" ? { models: [], hasMore: false } : {},
  }));
  const bridge = spawnBridge(
    renderOrchestrationMcpServerSource({
      host: "127.0.0.1",
      port: fixture.port,
      threadId: "thread",
      token: "fixture",
      providerSessionId: "provider-session",
      providerInvocationStatePath: path.join(root, "state"),
    }),
  );
  return { fixture, bridge };
}

describe("MCP bridge model choice tools", () => {
  it("advertises the shared create_thread and list_available_models schemas", async () => {
    const { fixture, bridge } = await startBridge();
    const listed = await bridge.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (listed.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.find((tool) => tool.name === "create_thread")?.inputSchema).toEqual(
      CREATE_THREAD_TOOL_PARAMETERS,
    );
    expect(tools.find((tool) => tool.name === "list_available_models")?.inputSchema).toEqual(
      LIST_AVAILABLE_MODELS_PARAMETERS,
    );
    await bridge.close();
    await fixture.close();
  });

  it("passes the raw modelSelection through and lists models read-only", async () => {
    const { fixture, bridge } = await startBridge();
    const modelSelection = { provider: "claudeAgent", model: "claude-sonnet", options: { x: 1 } };
    await bridge.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "create_thread", arguments: { title: "t", task: "do", modelSelection } },
    });
    expect(fixture.requests[0]).toMatchObject({ action: "create_thread", modelSelection });

    const listed = await bridge.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_available_models", arguments: { limit: 5 } },
    });
    expect(fixture.requests[1]).toEqual({ action: "list_available_models", limit: 5 });
    expect(JSON.stringify(listed)).toContain("hasMore");

    await bridge.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "create_thread", arguments: { title: "u", task: "do" } },
    });
    expect(fixture.requests[2]).not.toHaveProperty("modelSelection");
    await bridge.close();
    await fixture.close();
  });

  it("pre-approves only the read-only list tool for Claude", () => {
    const { allowedTools } = buildClaudeOrchestrationBridgeConfig({
      serverName: "bigbud_orchestration",
      serverPath: "/tmp/bridge.mjs",
    });
    expect(allowedTools).toContain("mcp__bigbud_orchestration__list_available_models");
    expect(allowedTools).not.toContain("mcp__bigbud_orchestration__create_thread");
  });
});
