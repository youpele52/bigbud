import * as FS from "node:fs";
import { describe, expect, it } from "vitest";
import { validateCuaDriverMcpProtocol, validateCuaDriverMcpTools } from "./mcpCompatibility";

interface InputSchema {
  properties: Record<string, { type: string; enum?: string[] }>;
  required?: string[];
  allOf?: unknown[];
}

function fixture() {
  const captured = JSON.parse(
    FS.readFileSync(
      new URL(
        "../../../../scripts/fixtures/cua-driver/0.38.0/live-schema.darwin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return {
    tools: Object.entries(captured.tools).map(([name, tool]) =>
      Object.assign({ name }, tool as { inputSchema: InputSchema }),
    ),
  };
}

describe("unfamiliar CUA MCP contract", () => {
  it.each([
    ["start_session", ["session", "capture_scope"]],
    ["end_session", ["session"]],
    ["list_apps", ["session"]],
    ["list_windows", ["session"]],
    ["get_accessibility_tree", ["session"]],
    ["launch_app", ["session", "name"]],
    ["bring_to_front", ["session", "pid"]],
    ["get_window_state", ["session", "pid", "window_id"]],
    ["click", ["session", "pid", "window_id", "x", "y", "button"]],
    ["drag", ["session", "pid", "window_id", "from_x", "from_y", "to_x", "to_y"]],
    ["scroll", ["session", "pid", "window_id", "direction", "amount"]],
    ["type_text", ["session", "pid", "window_id", "text"]],
    ["press_key", ["session", "pid", "window_id", "key"]],
    ["hotkey", ["session", "pid", "window_id", "keys"]],
  ] as const)("accepts required fields guaranteed by all %s calls", (name, required) => {
    const result = fixture();
    result.tools.find((tool) => tool.name === name)!.inputSchema.required = [...required];
    expect(() => validateCuaDriverMcpTools(result)).not.toThrow();
  });
  it.each([
    ["click", "element_token"],
    ["launch_app", "bundle_id"],
    ["bring_to_front", "window_id"],
    ["scroll", "x"],
    ["scroll", "y"],
    ["check_permissions", "prompt"],
    ["check_permissions", "session"],
    ["health_report", "session"],
    ["get_session_state", "session"],
    ["list_apps", "future"],
    ["list_windows", "pid"],
    ["get_accessibility_tree", "future"],
  ])("rejects required %s.%s absent from at least one call variant", (name, key) => {
    const result = fixture();
    const schema = result.tools.find((tool) => tool.name === name)!.inputSchema;
    schema.properties[key] ??= { type: "string" };
    schema.required = [...(schema.required ?? []), key];
    expect(() => validateCuaDriverMcpTools(result)).toThrow("new required arguments");
  });
  it("accepts the captured 0.38 argument subset and additive optional changes", () => {
    const result = fixture();
    validateCuaDriverMcpTools(result);
    for (const tool of result.tools) tool.inputSchema.properties.future = { type: "string" };
    validateCuaDriverMcpTools(result);
  });
  it.each(["type", "required", "enum", "constraint"])(
    "rejects same-name breaking %s changes",
    (change) => {
      const result = fixture();
      const click = result.tools.find((tool) => tool.name === "click")!.inputSchema;
      if (change === "type") click.properties.x!.type = "string";
      if (change === "required") click.required = ["future"];
      if (change === "enum") click.properties.button!.enum = ["left"];
      if (change === "constraint") click.allOf = [];
      expect(() => validateCuaDriverMcpTools(result)).toThrow(
        "incompatible input schema for click",
      );
    },
  );
  it("rejects unsupported or missing negotiated protocols", () => {
    validateCuaDriverMcpProtocol({ protocolVersion: "2025-06-18" });
    expect(() => validateCuaDriverMcpProtocol({ protocolVersion: "future" })).toThrow("protocol");
    expect(() => validateCuaDriverMcpProtocol({})).toThrow("protocol");
  });
});
