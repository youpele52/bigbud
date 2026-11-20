import { describe, expect, it } from "vitest";

import { buildOpencodeAllowedTools } from "./orchestrationMcpBridge.session.ts";

describe("buildOpencodeAllowedTools", () => {
  it("disables stale remote workspace tools for local sessions", () => {
    expect(
      buildOpencodeAllowedTools({
        toolIds: ["read", "bigbud_remote_workspace_read", "bigbud_remote_workspace_bash"],
        serverName: "bigbud_orchestration_thread_1",
      }),
    ).toEqual({
      read: true,
      bigbud_remote_workspace_read: false,
      bigbud_remote_workspace_bash: false,
    });
  });

  it("enables only this thread's orchestration tools", () => {
    expect(
      buildOpencodeAllowedTools({
        toolIds: [
          "bash",
          "bigbud_orchestration_other_computer_use",
          "bigbud_orchestration_thread_1_computer_use",
        ],
        serverName: "bigbud_orchestration_thread_1",
      }),
    ).toEqual({
      bash: true,
      bigbud_orchestration_other_computer_use: false,
      bigbud_orchestration_thread_1_computer_use: true,
    });
  });
});
