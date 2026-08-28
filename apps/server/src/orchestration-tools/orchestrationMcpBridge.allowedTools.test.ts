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

  it("prefers bigbud remote tools over native local workspace tools", () => {
    expect(
      buildOpencodeAllowedTools({
        toolIds: [
          "read",
          "bash",
          "bigbud_remote_workspace_read",
          "bigbud_remote_workspace_bash",
          "bigbud_orchestration_other_computer_use",
          "bigbud_orchestration_thread_1_computer_use",
        ],
        serverName: "bigbud_orchestration_thread_1",
        remoteWorkspaceServerName: "bigbud_remote_workspace",
      }),
    ).toEqual({
      read: false,
      bash: false,
      bigbud_remote_workspace_read: true,
      bigbud_remote_workspace_write: true,
      bigbud_remote_workspace_edit: true,
      bigbud_remote_workspace_bash: true,
      bigbud_remote_workspace_grep: true,
      bigbud_remote_workspace_glob: true,
      bigbud_remote_workspace_list: true,
      bigbud_remote_workspace_apply_patch: true,
      bigbud_orchestration_other_computer_use: false,
      bigbud_orchestration_thread_1_computer_use: true,
    });
  });
});
