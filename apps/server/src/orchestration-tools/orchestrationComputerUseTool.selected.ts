/**
 * The computer_use tool contract every consumer advertises, selected by the
 * pinned Driver release (`@bigbud/shared/computer-use/selection`). `legacy`
 * returns the 0.9.1 definitions verbatim; `v2` returns the definitions
 * generated from `orchestrationComputerUseTool.v2.ts`. Codex, Copilot, Pi, the
 * MCP template and the capability guide all read from here.
 */
import {
  COMPUTER_USE_ACCESSIBILITY_MAX_DEPTH,
  COMPUTER_USE_APP_NAME_MAX_CHARS,
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
  selectedComputerUseContractProfile,
  type ComputerUseContractProfile,
} from "@bigbud/shared/computer-use/selection";

import {
  COMPUTER_USE_TOOL_DESCRIPTION,
  COPILOT_COMPUTER_USE_PARAMETERS,
  renderPiComputerUseToolSource,
  renderPiComputerUseToolWith,
} from "./orchestrationComputerUseTool.shared.ts";
import {
  COMPUTER_USE_V2_PARAMETERS,
  COMPUTER_USE_V2_TOOL_DESCRIPTION,
  renderPiComputerUseV2ParametersSource,
} from "./orchestrationComputerUseTool.v2.ts";

export function computerUseToolDescription(
  profile: ComputerUseContractProfile = selectedComputerUseContractProfile,
): string {
  return profile === "v2" ? COMPUTER_USE_V2_TOOL_DESCRIPTION : COMPUTER_USE_TOOL_DESCRIPTION;
}

/** JSON schema for Codex dynamic tools and Copilot tools. */
export function computerUseToolParameters(
  profile: ComputerUseContractProfile = selectedComputerUseContractProfile,
): typeof COPILOT_COMPUTER_USE_PARAMETERS | typeof COMPUTER_USE_V2_PARAMETERS {
  return profile === "v2" ? COMPUTER_USE_V2_PARAMETERS : COPILOT_COMPUTER_USE_PARAMETERS;
}

export function renderPiComputerUseTool(
  profile: ComputerUseContractProfile = selectedComputerUseContractProfile,
): string {
  return profile === "v2"
    ? renderPiComputerUseToolWith(
        COMPUTER_USE_V2_TOOL_DESCRIPTION,
        renderPiComputerUseV2ParametersSource(),
      )
    : renderPiComputerUseToolSource();
}

/** Legacy (0.9.1) MCP computer_use definition lines; unchanged. */
const LEGACY_MCP_COMPUTER_USE_TOOL_LINES: ReadonlyArray<string> = [
  "  {",
  '    name: "computer_use",',
  `    description: ${JSON.stringify(COMPUTER_USE_TOOL_DESCRIPTION)},`,
  "    inputSchema: {",
  '      type: "object",',
  "      properties: {",
  "        action: {",
  '          type: "string",',
  '          enum: ["capture", "navigate", "click", "drag", "scroll", "type", "key", "wait", "get_page_info", "list_windows", "list_apps", "check_permissions", "doctor", "launch_app", "focus_app", "get_accessibility_tree"],',
  "        },",
  '        surface: { type: "string", enum: ["browser", "desktop"] },',
  `        url: { type: "string", maxLength: ${COMPUTER_USE_URL_MAX_CHARS}, pattern: "^https?://" },`,
  `        x: { type: "number", minimum: ${COMPUTER_USE_COORDINATE_MIN}, maximum: ${COMPUTER_USE_COORDINATE_MAX} },`,
  `        y: { type: "number", minimum: ${COMPUTER_USE_COORDINATE_MIN}, maximum: ${COMPUTER_USE_COORDINATE_MAX} },`,
  '        button: { type: "string", enum: ["left", "middle", "right"] },',
  `        startX: { type: "number", minimum: ${COMPUTER_USE_COORDINATE_MIN}, maximum: ${COMPUTER_USE_COORDINATE_MAX} },`,
  `        startY: { type: "number", minimum: ${COMPUTER_USE_COORDINATE_MIN}, maximum: ${COMPUTER_USE_COORDINATE_MAX} },`,
  `        endX: { type: "number", minimum: ${COMPUTER_USE_COORDINATE_MIN}, maximum: ${COMPUTER_USE_COORDINATE_MAX} },`,
  `        endY: { type: "number", minimum: ${COMPUTER_USE_COORDINATE_MIN}, maximum: ${COMPUTER_USE_COORDINATE_MAX} },`,
  `        deltaX: { type: "number", minimum: ${COMPUTER_USE_SCROLL_DELTA_MIN}, maximum: ${COMPUTER_USE_SCROLL_DELTA_MAX} },`,
  `        deltaY: { type: "number", minimum: ${COMPUTER_USE_SCROLL_DELTA_MIN}, maximum: ${COMPUTER_USE_SCROLL_DELTA_MAX} },`,
  `        text: { type: "string", maxLength: ${COMPUTER_USE_TEXT_MAX_CHARS} },`,
  `        key: { type: "string", maxLength: ${COMPUTER_USE_KEY_MAX_CHARS} },`,
  `        durationMs: { type: "integer", minimum: 1, maximum: ${COMPUTER_USE_WAIT_DURATION_MS_MAX} },`,
  '        prompt: { type: "boolean" },',
  `        name: { type: "string", maxLength: ${COMPUTER_USE_APP_NAME_MAX_CHARS} },`,
  '        pid: { type: "integer", minimum: 1 },',
  '        windowId: { type: "integer", minimum: 1 },',
  `        maxDepth: { type: "integer", minimum: 1, maximum: ${COMPUTER_USE_ACCESSIBILITY_MAX_DEPTH} },`,
  '        captureAfter: { type: "boolean" },',
  "      },",
  '      required: ["action"],',
  "      additionalProperties: false,",
  "    },",
  "  },",
];

/** MCP template source lines for the computer_use tool definition. */
export function renderMcpComputerUseToolLines(
  profile: ComputerUseContractProfile = selectedComputerUseContractProfile,
): ReadonlyArray<string> {
  if (profile !== "v2") return LEGACY_MCP_COMPUTER_USE_TOOL_LINES;
  return [
    "  {",
    '    name: "computer_use",',
    `    description: ${JSON.stringify(COMPUTER_USE_V2_TOOL_DESCRIPTION)},`,
    `    inputSchema: ${JSON.stringify(COMPUTER_USE_V2_PARAMETERS)},`,
    "  },",
  ];
}
