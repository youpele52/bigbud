import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildClaudeQueryOptions,
  materializeClaudeQuerySettings,
} from "./Adapter.session.options.ts";
import { resolveClaudeModelDiscovery } from "./Provider.capabilities.ts";

function build(
  forwardSubagentText: boolean,
  boundedHookProgress = true,
  harness?: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly settingSources?: ReadonlyArray<"user" | "project" | "local">;
    readonly protectedSettingsEnvironment?: Readonly<Record<string, string>>;
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
    ...(harness?.protectedSettingsEnvironment
      ? { protectedSettingsEnvironment: harness.protectedSettingsEnvironment }
      : {}),
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

  it("pins proxy connection settings in the SDK highest-priority flag layer", () => {
    const protectedSettingsEnvironment = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_AUTH_TOKEN: "test-token",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "custom-wire-model",
    };
    const options = build(false, false, {
      environment: protectedSettingsEnvironment,
      protectedSettingsEnvironment,
      settingSources: ["user", "project", "local"],
    });
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.settings).toEqual({ env: protectedSettingsEnvironment, apiKeyHelper: "" });
    expect(options.env).toEqual(protectedSettingsEnvironment);
  });

  it("materializes protected settings privately without credentials in argv", async () => {
    const options = build(false, true, {
      protectedSettingsEnvironment: { ANTHROPIC_AUTH_TOKEN: "private-test-token" },
    });
    const first = await materializeClaudeQuerySettings(options);
    const second = await materializeClaudeQuerySettings(options);
    try {
      expect(typeof first.options.settings).toBe("string");
      expect(first.options.settings).not.toBe(second.options.settings);
      const file = String(first.options.settings);
      expect(file).not.toContain("private-test-token");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        env: { ANTHROPIC_AUTH_TOKEN: "private-test-token" },
        apiKeyHelper: "",
      });
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
    await expect(stat(String(first.options.settings))).rejects.toMatchObject({ code: "ENOENT" });
    await first.cleanup(); // cleanup is idempotent
  });

  it("cleans the private directory when settings preparation fails", async () => {
    const directories = () =>
      readdir(tmpdir()).then((names) =>
        names.filter((name) => name.startsWith("bigbud-claude-settings-")),
      );
    const before = await directories();
    const options = build(false, true, {
      protectedSettingsEnvironment: { ANTHROPIC_AUTH_TOKEN: "test" },
    });
    const settings = options.settings as { env: Record<string, string> };
    Object.defineProperty(settings, "toJSON", {
      value: () => {
        throw new Error("encode failed");
      },
    });
    await expect(materializeClaudeQuerySettings(options)).rejects.toThrow("encode failed");
    expect(await directories()).toEqual(before);
  });

  it("pins configured application caps alongside protected route settings", () => {
    const options = buildClaudeQueryOptions({
      input: { runtimeMode: "approval-required" } as never,
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
      protectedSettingsEnvironment: { ANTHROPIC_MODEL: "wire" },
      subagentCaps: { maxSpawnDepth: 2, maxConcurrent: 3 },
    }).queryOptions;
    expect(options.settings).toMatchObject({
      env: {
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "2",
        CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "3",
      },
    });
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

    expect(buildEffort("not-advertised")).toBeUndefined();
    expect(buildEffort("not-advertised")).not.toBe("not-advertised");
    expect(buildEffort("ultrathink")).toBeUndefined();
  });
});
