/**
 * Public computer_use tool contract for the v2 profile (plan M3 "Update HTTP
 * decoding, Codex/Copilot dynamic tools, Pi generation, MCP templates ...
 * together"). ONE field table generates the JSON schema used by Codex,
 * Copilot and the MCP template and the TypeBox source used by Pi, so the
 * consumers cannot drift. The advertised schema is a flat superset of the
 * closed desktop v2 union and the unchanged browser actions; exact
 * per-action validation stays server-side (`decodeComputerUseToolRequest`).
 * Raw `pid`/`windowId` selectors are intentionally absent.
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
import { COMPUTER_USE_REF_MAX_CHARS } from "@bigbud/contracts/orchestration/computerUseDesktopV2.ts";

import { COMPUTER_USE_ACTION_ENUM } from "./orchestrationComputerUseTool.shared.ts";

type V2Field =
  | {
      readonly type: "string";
      readonly enum?: ReadonlyArray<string>;
      readonly maxLength?: number;
      readonly pattern?: string;
    }
  | {
      readonly type: "number" | "integer";
      readonly minimum?: number;
      readonly maximum?: number;
      readonly enum?: ReadonlyArray<number>;
    }
  | { readonly type: "boolean" };

const coordinate = {
  type: "number",
  minimum: COMPUTER_USE_COORDINATE_MIN,
  maximum: COMPUTER_USE_COORDINATE_MAX,
} as const;
const scrollDelta = {
  type: "number",
  minimum: COMPUTER_USE_SCROLL_DELTA_MIN,
  maximum: COMPUTER_USE_SCROLL_DELTA_MAX,
} as const;
const reference = { type: "string", maxLength: COMPUTER_USE_REF_MAX_CHARS } as const;

/** Insertion order is the advertised property order. */
export const COMPUTER_USE_V2_FIELDS: Readonly<Record<string, V2Field>> = {
  action: { type: "string", enum: [...COMPUTER_USE_ACTION_ENUM] },
  schemaVersion: { type: "integer", enum: [2] },
  surface: { type: "string", enum: ["browser", "desktop"] },
  targetRef: reference,
  observationRef: reference,
  delivery: { type: "string", enum: ["foreground", "background"] },
  background: { type: "boolean" },
  url: { type: "string", maxLength: COMPUTER_USE_URL_MAX_CHARS, pattern: "^https?://" },
  x: coordinate,
  y: coordinate,
  button: { type: "string", enum: ["left", "middle", "right"] },
  startX: coordinate,
  startY: coordinate,
  endX: coordinate,
  endY: coordinate,
  deltaX: scrollDelta,
  deltaY: scrollDelta,
  text: { type: "string", maxLength: COMPUTER_USE_TEXT_MAX_CHARS },
  key: { type: "string", maxLength: COMPUTER_USE_KEY_MAX_CHARS },
  durationMs: { type: "integer", minimum: 1, maximum: COMPUTER_USE_WAIT_DURATION_MS_MAX },
  prompt: { type: "boolean" },
  name: { type: "string", maxLength: COMPUTER_USE_APP_NAME_MAX_CHARS },
  maxDepth: { type: "integer", minimum: 1, maximum: COMPUTER_USE_ACCESSIBILITY_MAX_DEPTH },
  captureAfter: { type: "boolean" },
};

export const COMPUTER_USE_V2_PARAMETERS = {
  type: "object",
  properties: COMPUTER_USE_V2_FIELDS,
  required: ["action"],
  additionalProperties: false,
} as const;

export const COMPUTER_USE_V2_TOOL_DESCRIPTION =
  'Automate native desktop apps via the `computer_use` tool. Every desktop request must include `schemaVersion: 2` and `surface: "desktop"`. Address windows only through opaque `targetRef` values returned by list_windows, capture, launch_app or focus_app, and give click, drag and coordinate scroll the `observationRef` of the capture whose pixels you are using; coordinates are zero-based pixels of that capture. References are bound to this thread, expire, and never transfer; raw pid/windowId selectors are rejected. type and key need an exact `targetRef`. `delivery` is "foreground" or "background"; when omitted the user\'s default applies, and a refused delivery is never escalated automatically. Results carry `completion` (not_started, completed or unknown) and, on refusal, a stable `errorCode`; on `observation_stale` or `target_stale` capture again instead of reusing old coordinates, and never repeat an action whose completion is unknown without checking first. Use the separate `browser` tool for bigbud\'s built-in browser. Read-only actions (capture, list_windows, list_apps, check_permissions, doctor, get_accessibility_tree) work in any runtime mode. Mutating actions require full-access runtime mode.';

function typeBoxOptions(field: V2Field): string {
  const options: Record<string, unknown> = {};
  if ("maxLength" in field && field.maxLength !== undefined) options.maxLength = field.maxLength;
  if ("pattern" in field && field.pattern !== undefined) options.pattern = field.pattern;
  if ("minimum" in field && field.minimum !== undefined) options.minimum = field.minimum;
  if ("maximum" in field && field.maximum !== undefined) options.maximum = field.maximum;
  return Object.keys(options).length === 0 ? "" : JSON.stringify(options);
}

/** TypeBox source for one field; the same table as the JSON schema. */
export function renderTypeBoxField(field: V2Field): string {
  if (field.type === "boolean") return "Type.Boolean()";
  if (field.enum !== undefined) {
    const literals = field.enum.map((value) => `Type.Literal(${JSON.stringify(value)})`);
    return literals.length === 1 ? literals[0]! : `Type.Union([${literals.join(", ")}])`;
  }
  const builder =
    field.type === "string" ? "String" : field.type === "integer" ? "Integer" : "Number";
  return `Type.${builder}(${typeBoxOptions(field)})`;
}

export function renderPiComputerUseV2ParametersSource(): ReadonlyArray<string> {
  return Object.entries(COMPUTER_USE_V2_FIELDS).map(([name, field]) =>
    name === "action"
      ? `    action: ${renderTypeBoxField(field)},`
      : `    ${name}: Type.Optional(${renderTypeBoxField(field)}),`,
  );
}
