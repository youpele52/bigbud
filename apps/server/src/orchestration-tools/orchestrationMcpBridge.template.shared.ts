import {
  ARCHIVE_THREAD_TOOL_DESCRIPTION,
  GET_THREAD_STATUS_TOOL_DESCRIPTION,
  RENAME_THREAD_TOOL_DESCRIPTION,
  renderThreadOrchestrationConfigLiteral,
  type ThreadOrchestrationHttpConfig,
} from "./threadOrchestrationBridge.shared.ts";

export const ORCHESTRATION_MCP_SERVER_NAME = "bigbud_orchestration";

export const ORCHESTRATION_MCP_TOOL_DEFINITIONS = [
  "const TOOLS = [",
  "  {",
  '    name: "rename_thread",',
  `    description: ${JSON.stringify(RENAME_THREAD_TOOL_DESCRIPTION)},`,
  "    inputSchema: {",
  '      type: "object",',
  "      properties: {",
  '        title: { type: "string", description: "New thread title" },',
  "      },",
  '      required: ["title"],',
  "      additionalProperties: false,",
  "    },",
  "  },",
  "  {",
  '    name: "archive_thread",',
  `    description: ${JSON.stringify(ARCHIVE_THREAD_TOOL_DESCRIPTION)},`,
  "    inputSchema: {",
  '      type: "object",',
  "      properties: {},",
  "      required: [],",
  "      additionalProperties: false,",
  "    },",
  "  },",
  "  {",
  '    name: "get_thread_status",',
  `    description: ${JSON.stringify(GET_THREAD_STATUS_TOOL_DESCRIPTION)},`,
  "    inputSchema: {",
  '      type: "object",',
  "      properties: {",
  '        threadId: { type: "string", description: "Thread ID to inspect" },',
  "      },",
  '      required: ["threadId"],',
  "      additionalProperties: false,",
  "    },",
  "  },",
  "];",
  "",
];

export function renderOrchestrationMcpConfig(input: ThreadOrchestrationHttpConfig): string {
  return renderThreadOrchestrationConfigLiteral(input);
}
