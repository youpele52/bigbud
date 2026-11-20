import { PEER_TOOL_SPECS } from "./peerTools.shared.ts";
import { REMOTE_AGENT_TOOL_SPECS } from "./remoteAgentTools.shared.ts";

/**
 * Pi `remote_agent_status` and `remote_agent_install` (`remoteAgentTools`), rendered from the
 * same specs as the MCP bridge and forwarding the same `remote_agent` action, so Pi agents reach
 * the shared install operation with their per-thread tool credential. The P8 peer tools
 * (`delegate_to_host`, status, cancel) ride along on the `peer` action, keyed by the tool call id.
 * Relies on the bridge's `callOrchestrationTool` and `textResult`.
 */
export function renderPiRemoteAgentToolsSource(options: { readonly peerTools: boolean }): string {
  return [
    `const remoteAgentToolSpecs = ${JSON.stringify(REMOTE_AGENT_TOOL_SPECS)};`,
    "const remoteAgentTools = remoteAgentToolSpecs.map((spec) => defineTool({",
    "  name: spec.name,",
    "  label: spec.name,",
    "  description: spec.description,",
    "  parameters: spec.parameters,",
    "  async execute(_toolCallId, args) {",
    "    const result = await callOrchestrationTool({ action: 'remote_agent', remoteAgentTool: spec.name, remoteAgentArguments: args ?? {} });",
    "    return textResult(JSON.stringify(result.result ?? {}, null, 2));",
    "  },",
    "}));",
    `const peerToolSpecs = ${JSON.stringify(options.peerTools ? PEER_TOOL_SPECS : [])};`,
    "for (const spec of peerToolSpecs) remoteAgentTools.push(defineTool({",
    "  name: spec.name,",
    "  label: spec.name,",
    "  description: spec.description,",
    "  parameters: spec.parameters,",
    "  async execute(toolCallId, args) {",
    "    const result = await callOrchestrationTool({ action: 'peer', peerTool: spec.name, peerArguments: args ?? {}, invocationId: toolCallId });",
    "    return textResult(JSON.stringify(result.result ?? {}, null, 2));",
    "  },",
    "}));",
  ].join("\n");
}
