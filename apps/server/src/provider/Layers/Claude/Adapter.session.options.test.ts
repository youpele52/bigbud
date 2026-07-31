import { describe, expect, it } from "vitest";

import { buildClaudeQueryOptions } from "./Adapter.session.options.ts";

function build(
  forwardSubagentText: boolean,
  boundedHookProgress = true,
  harness?: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly settingSources?: readonly [];
  },
) {
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
    ...(harness?.environment ? { environment: harness.environment } : {}),
    ...(harness?.settingSources ? { settingSources: harness.settingSources } : {}),
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

  it("isolates a Claude-compatible harness environment and setting sources", () => {
    const environment = {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_AUTH_TOKEN: "test-token",
    };
    const options = build(false, true, { environment, settingSources: [] });

    expect(options.env).toEqual(environment);
    expect(options.settingSources).toEqual([]);
    expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });
});
