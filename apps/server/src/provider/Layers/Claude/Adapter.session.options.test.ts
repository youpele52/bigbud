import { describe, expect, it } from "vitest";

import { buildClaudeQueryOptions } from "./Adapter.session.options.ts";

function build(forwardSubagentText: boolean, boundedHookProgress = true) {
  return buildClaudeQueryOptions({
    input: { provider: "claudeAgent", runtimeMode: "full-access" } as never,
    claudeBinaryPath: "claude",
    orchestrationConfig: { mcpServers: {}, allowedTools: [] },
    runtimeCwd: undefined,
    remoteQueryOptions: undefined,
    hasRemoteWorkspaceBridge: false,
    existingResumeSessionId: undefined,
    resumeSessionAt: undefined,
    newSessionId: undefined,
    canUseTool: undefined,
    boundedHookProgress,
    forwardSubagentText,
  }).queryOptions;
}

describe("buildClaudeQueryOptions forwarded subagent rollout", () => {
  it("keeps forwarded subagent text disabled by default", () => {
    expect(build(false).forwardSubagentText).toBeUndefined();
  });

  it("enables forwarded subagent text only when explicitly rolled out", () => {
    expect(build(true).forwardSubagentText).toBe(true);
  });

  it("can disable bounded hook and progress events", () => {
    expect(build(false, false).includeHookEvents).toBeUndefined();
    expect(build(false, false).agentProgressSummaries).toBeUndefined();
  });
});
