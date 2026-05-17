import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createPiRemoteWorkspaceBridge } from "./PiRemoteWorkspaceBridge.ts";

describe("PiRemoteWorkspaceBridge", () => {
  it("creates an extension-backed synthetic cwd for remote workspaces", async () => {
    const bridge = await createPiRemoteWorkspaceBridge({
      location: "remote",
      executionTargetId: "ssh:host=devbox&user=root&port=22",
      cwd: "/srv/project",
    });

    const extensionPath = `${bridge.cwd}/.bigbud/bigbud-remote-workspace-bridge.ts`;
    expect(bridge.extensionPath).toBe(extensionPath);
    expect(bridge.extraArgs).toEqual([
      "--no-builtin-tools",
      "--no-extensions",
      "--extension",
      extensionPath,
    ]);

    const source = await fs.readFile(extensionPath, "utf8");
    expect(source).toContain('name: "read"');
    expect(source).toContain('name: "write"');
    expect(source).toContain('name: "edit"');
    expect(source).toContain('name: "bash"');
    expect(source).toContain("/srv/project");
    expect(source).toContain("root@devbox");

    await bridge.cleanup();
    await expect(fs.access(bridge.cwd)).rejects.toThrow();
  });
});
