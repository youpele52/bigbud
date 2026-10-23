import { describe, expect, it } from "vitest";

import { buildClaudeQueryOptions } from "./Adapter.session.options.ts";

const DEPTH = "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH";
const CONCURRENT = "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS";

function env(
  subagentCaps: Parameters<typeof buildClaudeQueryOptions>[0]["subagentCaps"],
  environment: Readonly<Record<string, string | undefined>> = { PATH: "/usr/bin" },
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
    boundedHookProgress: true,
    forwardSubagentText: false,
    environment,
    ...(subagentCaps ? { subagentCaps } : {}),
  }).queryOptions.env;
}

describe("Claude subagent caps (6.6)", () => {
  it("leaves the environment untouched when no cap is set", () => {
    const environment = { PATH: "/usr/bin" };
    expect(env(undefined, environment)).toBe(environment);
    expect(env({ maxSpawnDepth: null, maxConcurrent: null }, environment)).toBe(environment);
  });

  it("maps configured caps to the Claude Code environment variables", () => {
    const result = env({ maxSpawnDepth: 2, maxConcurrent: 4 });
    expect(result).toMatchObject({ PATH: "/usr/bin", [DEPTH]: "2", [CONCURRENT]: "4" });
  });

  it("sets only the configured cap and keeps a value the user already exported", () => {
    const result = env({ maxSpawnDepth: null, maxConcurrent: 3 }, { [DEPTH]: "5" });
    expect(result).toEqual({ [DEPTH]: "5", [CONCURRENT]: "3" });
  });
});

describe("Claude interrupted-turn resume stays bigbud's decision", () => {
  const RESUME = "CLAUDE_CODE_RESUME_INTERRUPTED_TURN";

  it("drops a user's own CLAUDE_CODE_RESUME_INTERRUPTED_TURN from the CLI environment", () => {
    const result = env(
      { maxSpawnDepth: 2, maxConcurrent: null },
      { PATH: "/usr/bin", [RESUME]: "1" },
    );
    expect(result).not.toHaveProperty(RESUME);
    expect(result).toMatchObject({ PATH: "/usr/bin", [DEPTH]: "2" });
    expect(env(undefined, { [RESUME]: "true" })).toEqual({});
  });
});
