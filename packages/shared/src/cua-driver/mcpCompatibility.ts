import { CUA_DRIVER_REQUIRED_TOOLS } from "./policy";

export const CUA_DRIVER_MCP_PROTOCOL_VERSION = "2025-06-18";

type Schema = Record<string, unknown>;
const string = { type: "string" };
const integer = { type: "integer" };
const number = { type: "number" };
const target = { pid: integer, window_id: integer };

// Only arguments emitted by ComputerUse.desktop.actions/session/observation and
// desktop permission checks. This is not a general JSON Schema compatibility engine.
const argumentsByTool: Record<string, Record<string, Schema>> = {
  start_session: { capture_scope: { type: "string", enum: ["auto"] } },
  get_session_state: {},
  end_session: {},
  health_report: {},
  check_permissions: { prompt: { type: "boolean" } },
  list_apps: {},
  list_windows: {},
  get_accessibility_tree: {},
  get_window_state: target,
  launch_app: { name: string },
  bring_to_front: target,
  click: {
    ...target,
    x: number,
    y: number,
    button: { type: "string", enum: ["left", "right", "middle"] },
  },
  drag: { ...target, from_x: number, from_y: number, to_x: number, to_y: number },
  scroll: {
    ...target,
    x: number,
    y: number,
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    amount: { type: "integer", minimum: 1, maximum: 50 },
  },
  type_text: { ...target, text: string },
  press_key: { ...target, key: string },
  hotkey: { ...target, keys: { type: "array", items: string, minItems: 2 } },
};
// Intersection of emitted keys across production call variants, not the pinned
// schema's required list. desktop.session supplies session for action calls;
// desktop.target filters out windows without pid/window_id before capture/input.
const scopedTarget = ["session", "pid", "window_id"];
const requiredByTool: Record<(typeof CUA_DRIVER_REQUIRED_TOOLS)[number], readonly string[]> = {
  start_session: ["session", "capture_scope"],
  end_session: ["session"],
  get_session_state: [], // Required capability, but no production call shape yet.
  health_report: [], // Daemon startup and server doctor send {} without session.
  check_permissions: [], // Desktop sends prompt but no session; actions may omit prompt.
  list_apps: ["session"],
  list_windows: ["session"],
  get_accessibility_tree: ["session"],
  launch_app: ["session", "name"],
  bring_to_front: ["session", "pid"], // Name-based focus omits window_id.
  get_window_state: scopedTarget,
  click: [...scopedTarget, "x", "y", "button"],
  drag: [...scopedTarget, "from_x", "from_y", "to_x", "to_y"],
  scroll: [...scopedTarget, "direction", "amount"], // x/y are optional.
  type_text: [...scopedTarget, "text"],
  press_key: [...scopedTarget, "key"],
  hotkey: [...scopedTarget, "keys"],
};
const annotations = new Set([
  "description",
  "title",
  "default",
  "examples",
  "$schema",
  "deprecated",
]);

function record(value: unknown): Schema {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object schema.");
  return value as Schema;
}

/** Fail closed on new constraints we cannot prove accept bigbud's existing inputs. */
function accepts(actual: Schema, expected: Schema): boolean {
  if (actual.type !== expected.type && !(actual.type === "number" && expected.type === "integer"))
    return false;
  for (const [key, value] of Object.entries(actual)) {
    if (annotations.has(key) || key === "type") continue;
    if (key === "enum") {
      if (
        !Array.isArray(value) ||
        !Array.isArray(expected.enum) ||
        !expected.enum.every((item) => value.includes(item))
      )
        return false;
    } else if (key === "items") {
      if (!expected.items || !accepts(record(value), record(expected.items))) return false;
    } else if (key === "minimum" || key === "minItems") {
      if (typeof value !== "number" || typeof expected[key] !== "number" || value > expected[key])
        return false;
    } else if (key === "maximum") {
      if (typeof value !== "number" || typeof expected[key] !== "number" || value < expected[key])
        return false;
    } else return false;
  }
  return true;
}

export function validateCuaDriverMcpProtocol(result: unknown): void {
  if (record(result).protocolVersion !== CUA_DRIVER_MCP_PROTOCOL_VERSION) {
    throw new Error("cua-driver negotiated an unsupported MCP protocol version.");
  }
}

/** Validate unfamiliar releases without executing any desktop action. Additive optional fields are safe. */
export function validateCuaDriverMcpTools(result: unknown): void {
  const tools = record(result).tools;
  if (!Array.isArray(tools)) throw new Error("cua-driver returned no MCP tools.");
  for (const name of CUA_DRIVER_REQUIRED_TOOLS) {
    try {
      const matches = tools.filter((tool) => record(tool).name === name);
      if (matches.length !== 1) throw new Error("missing or duplicate tool");
      const schema = record(record(matches[0]).inputSchema);
      if (schema.type !== "object") throw new Error("expected object input");
      for (const key of Object.keys(schema)) {
        if (
          !["type", "properties", "required", "additionalProperties"].includes(key) &&
          !annotations.has(key)
        )
          throw new Error(`unsupported constraint ${key}`);
      }
      if (
        schema.additionalProperties !== undefined &&
        typeof schema.additionalProperties !== "boolean"
      )
        throw new Error("unsupported additionalProperties");
      const required = schema.required ?? [];
      if (!Array.isArray(required) || !required.every((key) => requiredByTool[name].includes(key)))
        throw new Error("new required arguments");
      const properties = record(schema.properties);
      for (const [key, expected] of Object.entries({ ...argumentsByTool[name], session: string })) {
        if (!accepts(record(properties[key]), expected))
          throw new Error(`incompatible argument ${key}`);
      }
    } catch (cause) {
      throw new Error(`cua-driver has an incompatible input schema for ${name}: ${String(cause)}`, {
        cause,
      });
    }
  }
}
