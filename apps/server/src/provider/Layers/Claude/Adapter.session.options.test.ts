import { describe, expect, it } from "vitest";

import { buildClaudeQueryOptions } from "./Adapter.session.options.ts";
import { resolveClaudeModelDiscovery } from "./Provider.capabilities.ts";

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

  it("enables typed Ultracode settings only for SDK-advertised xhigh models", () => {
    resolveClaudeModelDiscovery({
      durationMs: 1,
      models: [
        {
          value: "claude-opus-4-7",
          displayName: "Claude Opus 4.7",
          description: "Opus",
          supportsEffort: true,
          supportedEffortLevels: ["high", "xhigh"],
        },
      ],
    });
    const result = buildClaudeQueryOptions({
      input: {
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: { ultracode: true },
        },
      } as never,
      claudeBinaryPath: "claude",
      orchestrationConfig: { mcpServers: {}, allowedTools: [] },
      runtimeCwd: undefined,
      remoteQueryOptions: undefined,
      hasRemoteWorkspaceBridge: false,
      existingResumeSessionId: undefined,
      resumeSessionAt: undefined,
      newSessionId: undefined,
      canUseTool: undefined,
      boundedHookProgress: false,
      forwardSubagentText: false,
    });

    expect(result.effectiveEffort).toBe("xhigh");
    expect(result.queryOptions.effort).toBe("xhigh");
    expect(result.queryOptions.settings).toMatchObject({ ultracode: true });
  });

  it("forwards a future effort only when advertised by live SDK metadata", () => {
    resolveClaudeModelDiscovery({
      durationMs: 1,
      models: [
        {
          value: "claude-future",
          displayName: "Claude Future",
          description: "Future model",
          supportsEffort: true,
          supportedEffortLevels: ["high", "future-depth"],
        },
      ],
    });
    const result = buildClaudeQueryOptions({
      input: {
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-future",
          options: { effort: "future-depth" },
        },
      } as never,
      claudeBinaryPath: "claude",
      orchestrationConfig: { mcpServers: {}, allowedTools: [] },
      runtimeCwd: undefined,
      remoteQueryOptions: undefined,
      hasRemoteWorkspaceBridge: false,
      existingResumeSessionId: undefined,
      resumeSessionAt: undefined,
      newSessionId: undefined,
      canUseTool: undefined,
      boundedHookProgress: false,
      forwardSubagentText: false,
    });

    expect(result.queryOptions.effort).toBe("future-depth");
  });

  it("never forwards unadvertised or legacy prompt-injected values as native effort", () => {
    resolveClaudeModelDiscovery({
      durationMs: 1,
      models: [
        {
          value: "claude-safe",
          displayName: "Claude Safe",
          description: "Safe model",
          supportsEffort: true,
          supportedEffortLevels: ["high"],
        },
      ],
    });
    const buildEffort = (effort: string) =>
      buildClaudeQueryOptions({
        input: {
          provider: "claudeAgent",
          runtimeMode: "full-access",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-safe",
            options: { effort },
          },
        } as never,
        claudeBinaryPath: "claude",
        orchestrationConfig: { mcpServers: {}, allowedTools: [] },
        runtimeCwd: undefined,
        remoteQueryOptions: undefined,
        hasRemoteWorkspaceBridge: false,
        existingResumeSessionId: undefined,
        resumeSessionAt: undefined,
        newSessionId: undefined,
        canUseTool: undefined,
        boundedHookProgress: false,
        forwardSubagentText: false,
      }).queryOptions.effort;

    expect(buildEffort("not-advertised")).toBe("high");
    expect(buildEffort("not-advertised")).not.toBe("not-advertised");
    expect(buildEffort("ultrathink")).toBeUndefined();
  });
});
