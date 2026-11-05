import { ComputerUseDesktopV2Action } from "@bigbud/contracts/orchestration/computerUseDesktopV2.ts";
import { describe, expect, it } from "vitest";

import {
  COMPUTER_USE_TOOL_DESCRIPTION,
  COPILOT_COMPUTER_USE_PARAMETERS,
  renderPiComputerUseToolSource,
} from "./orchestrationComputerUseTool.shared.ts";
import {
  computerUseToolDescription,
  computerUseToolParameters,
  renderMcpComputerUseToolLines,
  renderPiComputerUseTool,
} from "./orchestrationComputerUseTool.selected.ts";
import { COMPUTER_USE_V2_PARAMETERS } from "./orchestrationComputerUseTool.v2.ts";

/** Every key the closed v2 desktop structs declare, except the forbidden selectors. */
function v2DesktopFieldNames(): Set<string> {
  const names = new Set<string>();
  for (const member of ComputerUseDesktopV2Action.members) {
    for (const name of Object.keys(member.fields)) names.add(name);
  }
  names.delete("pid");
  names.delete("windowId");
  return names;
}

/** Re-evaluates the generated MCP definition lines as the template does. */
function mcpDefinition(lines: ReadonlyArray<string>): {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
} {
  // Evaluates generated template source exactly as the MCP server would load it.
  return new Function(`return [${lines.join("\n")}][0];`)();
}

function piPropertyNames(source: string): string[] {
  return [...source.matchAll(/^ {4}([A-Za-z]+): /gm)].map((match) => match[1]!);
}

describe("selected computer_use contract", () => {
  it("returns the legacy definitions verbatim under the legacy profile", () => {
    expect(computerUseToolDescription("legacy")).toBe(COMPUTER_USE_TOOL_DESCRIPTION);
    expect(computerUseToolParameters("legacy")).toBe(COPILOT_COMPUTER_USE_PARAMETERS);
    expect(renderPiComputerUseTool("legacy")).toBe(renderPiComputerUseToolSource());
    const legacyMcp = mcpDefinition(renderMcpComputerUseToolLines("legacy"));
    expect(legacyMcp.inputSchema).toEqual(COPILOT_COMPUTER_USE_PARAMETERS);
  });

  it("selects legacy for any pinned Driver", () => {
    expect(computerUseToolParameters()).toBe(COPILOT_COMPUTER_USE_PARAMETERS);
    expect(computerUseToolDescription()).toBe(COMPUTER_USE_TOOL_DESCRIPTION);
  });

  it("advertises every v2 desktop field and no raw selectors", () => {
    const advertised = new Set(Object.keys(COMPUTER_USE_V2_PARAMETERS.properties));
    for (const name of v2DesktopFieldNames()) expect(advertised, name).toContain(name);
    expect(advertised.has("pid")).toBe(false);
    expect(advertised.has("windowId")).toBe(false);
    // Browser fields are unchanged: v2 = legacy minus raw selectors plus v2 fields.
    const legacy = new Set(Object.keys(COPILOT_COMPUTER_USE_PARAMETERS.properties));
    legacy.delete("pid");
    legacy.delete("windowId");
    for (const name of legacy) expect(advertised, name).toContain(name);
    for (const name of advertised) {
      expect(legacy.has(name) || v2DesktopFieldNames().has(name), name).toBe(true);
    }
  });

  it("generates the same v2 property set for Codex/Copilot, Pi and MCP", () => {
    const json = Object.keys(computerUseToolParameters("v2").properties);
    expect(piPropertyNames(renderPiComputerUseTool("v2"))).toEqual(json);
    const mcp = mcpDefinition(renderMcpComputerUseToolLines("v2"));
    expect(mcp.name).toBe("computer_use");
    expect(mcp.inputSchema).toEqual(COMPUTER_USE_V2_PARAMETERS);
    // launch_app.background was previously missing from generated consumers.
    expect(json).toContain("background");
    expect(renderPiComputerUseTool("v2")).toContain("background: Type.Optional(Type.Boolean()),");
    expect(renderPiComputerUseTool("v2")).toContain(
      "schemaVersion: Type.Optional(Type.Literal(2)),",
    );
    expect(computerUseToolDescription("v2")).toContain("schemaVersion: 2");
  });
});
