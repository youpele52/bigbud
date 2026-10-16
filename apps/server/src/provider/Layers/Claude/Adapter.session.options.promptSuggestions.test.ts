import { describe, expect, it } from "vitest";

import { buildClaudeQueryOptions } from "./Adapter.session.options.ts";

const options = (promptSuggestions?: boolean) =>
  buildClaudeQueryOptions({
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
    ...(promptSuggestions !== undefined ? { promptSuggestions } : {}),
  }).queryOptions;

describe("Claude prompt suggestion option (Phase 7)", () => {
  it("asks the SDK for prompt suggestions only when the setting is on", () => {
    expect(options(true).promptSuggestions).toBe(true);
    expect(options(false).promptSuggestions).toBeUndefined();
    expect(options().promptSuggestions).toBeUndefined();
  });
});
