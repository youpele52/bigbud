import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { createCodexRemoteWorkspaceBridge } from "./codexRemoteWorkspaceBridge.ts";

describe("codexRemoteWorkspaceBridge", () => {
  it("creates a self-contained MCP server and codex config overrides", async () => {
    const bridge = await createCodexRemoteWorkspaceBridge(
      {
        location: "remote",
        executionTargetId: "ssh:host=devbox&user=root&port=22",
        cwd: "/srv/project",
      },
      { host: "127.0.0.1", port: 3000, threadId: "thread-1", token: "token-1" },
    );

    expect(bridge.cwd).toContain("bigbud-codex-remote-workspace-");
    expect(bridge.configArgs).toEqual([
      "-c",
      "app.default_tools_enabled=false",
      "-c",
      expect.stringContaining("mcp_servers.bigbud_remote_workspace.command="),
      "-c",
      expect.stringContaining("mcp_servers.bigbud_remote_workspace.args="),
      "-c",
      expect.stringContaining("mcp_servers.bigbud_remote_workspace.cwd="),
    ]);
    expect(bridge.promptPrefix).toContain("bigbud remote workspace mode");
    expect(bridge.promptPrefix).toContain("/srv/project");

    const serverPath = path.join(bridge.cwd, ".bigbud/remote-workspace-mcp-server.mjs");
    const source = await fs.readFile(serverPath, "utf8");
    expect(source).toContain('name: "read"');
    expect(source).toContain('name: "apply_patch"');
    expect(source).toContain("remote_workspace_process");
    expect(source).toContain("token-1");
    expect(source).not.toContain("root@devbox");

    const check = spawnSync(process.execPath, ["--check", serverPath], {
      encoding: "utf8",
    });
    expect(check.status).toBe(0);
    expect(check.stderr).toBe("");

    await bridge.cleanup();
    await expect(fs.access(bridge.cwd)).rejects.toThrow();
  });
});
