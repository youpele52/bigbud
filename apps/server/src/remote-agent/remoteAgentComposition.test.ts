import { describe, expect, it } from "vitest";

import { makeRemoteAgentComposition } from "./remoteAgentComposition.ts";

describe("remote agent composition", () => {
  it("keeps workspace, Git, and shell adapters on one target-aware pool", () => {
    const composition = makeRemoteAgentComposition({
      binaryPath: "$HOME/.bigbud/agent/bin/0.1.0/bigbud-remote-agent",
    });

    expect(composition.workspaceRuntime.files.readFilePreview).toBeTypeOf("function");
    expect(composition.gitExecutor).toBeTypeOf("function");
    expect(composition.shellRunner.resolve("ssh:example")).toBe(
      composition.shellRunner.resolve("ssh:example"),
    );
    composition.pool.closeAll();
  });
});
