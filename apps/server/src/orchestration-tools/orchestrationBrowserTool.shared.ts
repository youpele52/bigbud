import {
  COMPUTER_USE_COORDINATE_MAX,
  COMPUTER_USE_COORDINATE_MIN,
  COMPUTER_USE_KEY_MAX_CHARS,
  COMPUTER_USE_SCROLL_DELTA_MAX,
  COMPUTER_USE_SCROLL_DELTA_MIN,
  COMPUTER_USE_TEXT_MAX_CHARS,
  COMPUTER_USE_URL_MAX_CHARS,
  COMPUTER_USE_WAIT_DURATION_MS_MAX,
} from "@bigbud/contracts/orchestration/computerUse.ts";

import {
  BROWSER_TOOL_DESCRIPTION,
  renderCallOrchestrationToolSource,
} from "./threadOrchestrationBridge.shared.ts";

export const BROWSER_ACTION_ENUM = [
  "capture",
  "navigate",
  "click",
  "drag",
  "scroll",
  "type",
  "key",
  "wait",
  "get_page_info",
  "get_page_text",
  "go_back",
  "go_forward",
  "reload",
  "release_tab",
  "close_tab",
] as const;

export const BROWSER_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...BROWSER_ACTION_ENUM] },
    target: { type: "string", enum: ["auto", "visible", "background"] },
    tabId: { type: "string", maxLength: 256 },
    url: { type: "string", maxLength: COMPUTER_USE_URL_MAX_CHARS, pattern: "^https?://" },
    x: {
      type: "number",
      minimum: COMPUTER_USE_COORDINATE_MIN,
      maximum: COMPUTER_USE_COORDINATE_MAX,
    },
    y: {
      type: "number",
      minimum: COMPUTER_USE_COORDINATE_MIN,
      maximum: COMPUTER_USE_COORDINATE_MAX,
    },
    button: { type: "string", enum: ["left", "middle", "right"] },
    startX: {
      type: "number",
      minimum: COMPUTER_USE_COORDINATE_MIN,
      maximum: COMPUTER_USE_COORDINATE_MAX,
    },
    startY: {
      type: "number",
      minimum: COMPUTER_USE_COORDINATE_MIN,
      maximum: COMPUTER_USE_COORDINATE_MAX,
    },
    endX: {
      type: "number",
      minimum: COMPUTER_USE_COORDINATE_MIN,
      maximum: COMPUTER_USE_COORDINATE_MAX,
    },
    endY: {
      type: "number",
      minimum: COMPUTER_USE_COORDINATE_MIN,
      maximum: COMPUTER_USE_COORDINATE_MAX,
    },
    deltaX: {
      type: "number",
      minimum: COMPUTER_USE_SCROLL_DELTA_MIN,
      maximum: COMPUTER_USE_SCROLL_DELTA_MAX,
    },
    deltaY: {
      type: "number",
      minimum: COMPUTER_USE_SCROLL_DELTA_MIN,
      maximum: COMPUTER_USE_SCROLL_DELTA_MAX,
    },
    text: { type: "string", maxLength: COMPUTER_USE_TEXT_MAX_CHARS },
    key: { type: "string", maxLength: COMPUTER_USE_KEY_MAX_CHARS },
    durationMs: { type: "integer", minimum: 1, maximum: COMPUTER_USE_WAIT_DURATION_MS_MAX },
    captureAfter: { type: "boolean" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

export function renderPiBrowserToolSource(): string {
  return [
    "const browserTool = defineTool({",
    '  name: "browser",',
    '  label: "browser",',
    `  description: ${JSON.stringify(BROWSER_TOOL_DESCRIPTION)},`,
    "  parameters: Type.Object({",
    `    action: Type.Union([${BROWSER_ACTION_ENUM.map((action) => `Type.Literal("${action}")`).join(", ")}]),`,
    '    target: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("visible"), Type.Literal("background")])),',
    "    tabId: Type.Optional(Type.String({ maxLength: 256 })),",
    `    url: Type.Optional(Type.String({ maxLength: ${COMPUTER_USE_URL_MAX_CHARS}, pattern: "^https?://" })),`,
    `    x: Type.Optional(Type.Number({ minimum: ${COMPUTER_USE_COORDINATE_MIN}, maximum: ${COMPUTER_USE_COORDINATE_MAX} })),`,
    `    y: Type.Optional(Type.Number({ minimum: ${COMPUTER_USE_COORDINATE_MIN}, maximum: ${COMPUTER_USE_COORDINATE_MAX} })),`,
    '    button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")])),',
    `    startX: Type.Optional(Type.Number({ minimum: ${COMPUTER_USE_COORDINATE_MIN}, maximum: ${COMPUTER_USE_COORDINATE_MAX} })),`,
    `    startY: Type.Optional(Type.Number({ minimum: ${COMPUTER_USE_COORDINATE_MIN}, maximum: ${COMPUTER_USE_COORDINATE_MAX} })),`,
    `    endX: Type.Optional(Type.Number({ minimum: ${COMPUTER_USE_COORDINATE_MIN}, maximum: ${COMPUTER_USE_COORDINATE_MAX} })),`,
    `    endY: Type.Optional(Type.Number({ minimum: ${COMPUTER_USE_COORDINATE_MIN}, maximum: ${COMPUTER_USE_COORDINATE_MAX} })),`,
    `    deltaX: Type.Optional(Type.Number({ minimum: ${COMPUTER_USE_SCROLL_DELTA_MIN}, maximum: ${COMPUTER_USE_SCROLL_DELTA_MAX} })),`,
    `    deltaY: Type.Optional(Type.Number({ minimum: ${COMPUTER_USE_SCROLL_DELTA_MIN}, maximum: ${COMPUTER_USE_SCROLL_DELTA_MAX} })),`,
    `    text: Type.Optional(Type.String({ maxLength: ${COMPUTER_USE_TEXT_MAX_CHARS} })),`,
    `    key: Type.Optional(Type.String({ maxLength: ${COMPUTER_USE_KEY_MAX_CHARS} })),`,
    `    durationMs: Type.Optional(Type.Number({ minimum: 1, maximum: ${COMPUTER_USE_WAIT_DURATION_MS_MAX} })),`,
    "    captureAfter: Type.Optional(Type.Boolean()),",
    "  }),",
    "  async execute(_toolCallId, args) {",
    "    const result = await callOrchestrationTool({ action: 'browser', browserAction: args });",
    "    return textResult(JSON.stringify(result.result ?? {}, null, 2));",
    "  },",
    "});",
  ].join("\n");
}

export { BROWSER_TOOL_DESCRIPTION, renderCallOrchestrationToolSource };
