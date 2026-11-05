import { describe, expect, it } from "vitest";

import { buildMuseOrchestrationBridgeConfig } from "./museThreadOrchestrationTools.ts";

describe("Muse thread orchestration bridge config", () => {
  it("converts the canonical bridge to a required stdio session MCP entry", () => {
    const config = buildMuseOrchestrationBridgeConfig({
      serverName: "bigbud",
      serverPath: "/tmp/bridge/orchestration-mcp-server.mjs",
    });
    const entry = config.mcpServers.bigbud;
    expect(entry?.transport).toBe("stdio");
    expect(entry?.mode).toBe("required");
    expect(entry?.framing).toBe("lineDelimitedJson");
    expect(entry?.args).toEqual(["/tmp/bridge/orchestration-mcp-server.mjs"]);
    expect(entry?.command.length).toBeGreaterThan(0);
    // No token or ephemeral bridge path is serialized into the MCP config.
    expect(JSON.stringify(config)).not.toContain("token");
  });
});
