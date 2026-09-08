import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { REMOTE_WORKSPACE_TOOL_NAMES } from "../../../remote-workspace-bridge/remoteWorkspaceTools.ts";
import { createOpencodeRemoteWorkspaceBridge } from "./OpencodeRemoteWorkspaceBridge.ts";

describe("OpencodeRemoteWorkspaceBridge", () => {
  it("creates a provider-neutral MCP bridge in a synthetic cwd", async () => {
    const bridge = await createOpencodeRemoteWorkspaceBridge(
      {
        location: "remote",
        executionTargetId: "ssh:host=devbox&user=root&port=22",
        cwd: "/srv/project",
      },
      { host: "127.0.0.1", port: 3000, threadId: "thread-1", token: "token-1" },
    );

    expect(bridge.serverName).toBe("bigbud_remote_workspace");
    const runtimeSource = await fs.readFile(bridge.serverPath, "utf8");
    expect(runtimeSource).toContain("remote_workspace_process");
    expect(runtimeSource).toContain("token-1");
    expect(runtimeSource).not.toContain("root@devbox");
    for (const toolName of REMOTE_WORKSPACE_TOOL_NAMES) {
      expect(runtimeSource).toContain(`name: "${toolName}"`);
    }
    expect(bridge.systemPrompt).toContain("The actual workspace root is /srv/project");
    expect(bridge.systemPrompt).toContain("prefer edit or write");
    await expect(fs.access(path.join(bridge.cwd, ".opencode/tools"))).rejects.toThrow();

    await bridge.cleanup();
    await expect(fs.access(bridge.cwd)).rejects.toThrow();
  });
});
