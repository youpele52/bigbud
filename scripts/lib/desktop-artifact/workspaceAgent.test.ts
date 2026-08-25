import { describe, expect, it } from "vitest";

import {
  packagedWorkspaceAgentPath,
  workspaceAgentBinaryName,
  workspaceAgentBuildPlan,
} from "./workspaceAgent.ts";

describe("desktop workspace agent staging", () => {
  it("uses platform-native binary names", () => {
    expect(workspaceAgentBinaryName("mac")).toBe("bigbud-remote-agent");
    expect(workspaceAgentBinaryName("linux")).toBe("bigbud-remote-agent");
    expect(workspaceAgentBinaryName("win")).toBe("bigbud-remote-agent.exe");
  });

  it("stages under the packaged server workspace-agent directory", () => {
    expect(packagedWorkspaceAgentPath("/stage/apps/server", "linux")).toBe(
      "/stage/apps/server/workspace-agent/bin/bigbud-remote-agent",
    );
  });

  it("uses a target-specific build and output for a requested cross-architecture artifact", () => {
    const plan = workspaceAgentBuildPlan({
      repoRoot: "/repo",
      platform: "mac",
      arch: "x64",
      hostPlatform: "darwin",
      hostArch: "arm64",
    });

    expect(plan.cargoArgs).toEqual([
      "build",
      "--locked",
      "--release",
      "--package",
      "bigbud-remote-agent",
      "--target",
      "x86_64-apple-darwin",
    ]);
    expect(plan.source).toBe("/repo/target/x86_64-apple-darwin/release/bigbud-remote-agent");
    expect(plan.target.rustOs).toBe("macos");
  });
});
