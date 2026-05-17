import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createCopilotRemoteWorkspaceBridge } from "./CopilotRemoteWorkspaceBridge.ts";

describe("CopilotRemoteWorkspaceBridge", () => {
  it("creates a session-fs bridge and overrides remote bash", async () => {
    const bridge = await createCopilotRemoteWorkspaceBridge({
      location: "remote",
      executionTargetId: "ssh:host=devbox&user=root&port=22",
      cwd: "/srv/project",
    });

    expect(bridge.runtimeCwd).toContain("bigbud-copilot-remote-workspace-");
    expect(bridge.clientSessionFsConfig.initialCwd).toBe("/srv/project");
    expect(bridge.clientSessionFsConfig.conventions).toBe("posix");
    expect(bridge.sessionConfig.excludedTools).toContain("read_bash");
    expect(bridge.sessionConfig.systemMessage?.content).toContain("/srv/project");
    expect(bridge.sessionConfig.systemMessage?.content).toContain("root@devbox");
    expect(bridge.sessionConfig.tools).toHaveLength(1);
    expect(bridge.sessionConfig.tools?.[0]?.name).toBe("bash");
    expect(bridge.sessionConfig.tools?.[0]?.overridesBuiltInTool).toBe(true);

    const readmePath = path.join(bridge.runtimeCwd, "README.txt");
    const source = await fs.readFile(readmePath, "utf8");
    expect(source).toContain("synthetic local workspace");

    await bridge.cleanup();
    await expect(fs.access(bridge.runtimeCwd)).rejects.toThrow();
  });
});
