import { expect, it } from "vitest";

import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import { renderPiOrchestrationBridgeSource } from "./PiOrchestrationBridge.template.ts";
import { REMOTE_AGENT_TOOL_NAMES } from "./remoteAgentTools.shared.ts";
import {
  resolvePiExtensionSource,
  runSource,
  withFixture,
} from "./threadToolTemplates.test.helpers.ts";

const forwarded = [
  expect.objectContaining({
    action: "remote_agent",
    remoteAgentTool: "remote_agent_status",
    remoteAgentArguments: { target: "dev@vps" },
  }),
  expect.objectContaining({
    action: "remote_agent",
    remoteAgentTool: "remote_agent_install",
    remoteAgentArguments: { target: "dev@vps", replace: true },
  }),
];

it("generated MCP bridge lists the remote-agent tools and forwards them to the shared action", async () => {
  await withFixture(async (config, requests) => {
    const messages =
      [
        { id: 1, method: "tools/list", params: {} },
        {
          id: 2,
          method: "tools/call",
          params: { name: "remote_agent_status", arguments: { target: "dev@vps" } },
        },
        {
          id: 3,
          method: "tools/call",
          params: { name: "remote_agent_install", arguments: { target: "dev@vps", replace: true } },
        },
      ]
        .map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }))
        .join("\n") + "\n";
    const responses = (await runSource(renderOrchestrationMcpServerSource(config), messages))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const tools = responses.find((response) => response.id === 1).result.tools as Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>;
    for (const name of REMOTE_AGENT_TOOL_NAMES) {
      expect(tools.map((tool) => tool.name)).toContain(name);
    }
    expect(tools.find((tool) => tool.name === "remote_agent_status")?.inputSchema).toMatchObject({
      required: ["target"],
    });
    expect(requests).toEqual(forwarded);
  });
});

it("generated Pi extension registers the remote-agent tools and forwards the same action", async () => {
  await withFixture(async (_config, requests) => {
    await runSource(
      resolvePiExtensionSource(renderPiOrchestrationBridgeSource(_config)) +
        `
const tools = [];
bigbudOrchestrationBridge({ registerTool(tool) { tools.push(tool); } });
for (const name of ${JSON.stringify(REMOTE_AGENT_TOOL_NAMES)}) {
  if (!tools.some(tool => tool.name === name)) throw new Error('missing ' + name);
}
await tools.find(tool => tool.name === 'remote_agent_status').execute('pi-status', { target: 'dev@vps' });
await tools.find(tool => tool.name === 'remote_agent_install').execute('pi-install', { target: 'dev@vps', replace: true });
`,
    );
    expect(requests).toEqual(forwarded);
  });
});
