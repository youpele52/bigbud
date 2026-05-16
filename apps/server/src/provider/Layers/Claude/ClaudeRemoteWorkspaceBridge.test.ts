import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { createClaudeRemoteWorkspaceBridge } from "./ClaudeRemoteWorkspaceBridge.ts";

describe("ClaudeRemoteWorkspaceBridge", () => {
  it("creates a self-contained MCP bridge with a remote-safe builtin tool list", async () => {
    const bridge = await createClaudeRemoteWorkspaceBridge({
      location: "remote",
      executionTargetId: "ssh:host=devbox&user=root&port=22",
      cwd: "/srv/project",
    });

    expect(bridge.cwd).toContain("bigbud-claude-remote-workspace-");
    expect(bridge.queryOptions.tools).toEqual(["AskUserQuestion", "TodoWrite", "ExitPlanMode"]);
    expect(bridge.queryOptions.allowedTools).toEqual([
      "mcp__bigbud_remote_workspace__read",
      "mcp__bigbud_remote_workspace__grep",
      "mcp__bigbud_remote_workspace__glob",
      "mcp__bigbud_remote_workspace__list",
    ]);

    const serverPath = path.join(bridge.cwd, ".bigbud/remote-workspace-mcp-server.mjs");
    const source = await fs.readFile(serverPath, "utf8");
    expect(source).toContain('name: "read"');
    expect(source).toContain('name: "apply_patch"');
    expect(source).toContain("root@devbox");

    const check = spawnSync(process.execPath, ["--check", serverPath], {
      encoding: "utf8",
    });
    expect(check.status).toBe(0);
    expect(check.stderr).toBe("");

    await bridge.cleanup();
    await expect(fs.access(bridge.cwd)).rejects.toThrow();
  });
});
