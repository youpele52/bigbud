import { expect, it } from "vitest";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";
import { v2RemoteToolPolicy } from "./Runtime.policy.remote.ts";

const server = "bbv2_remote_1234567890abcdef1234567890abcdef";
const issuer = "a".repeat(64);

it.each(["approval-required", "auto-accept-edits", "full-access"] as const)(
  "%s grants only the owning remote MCP and canonical thread tools",
  (mode) => {
    const policy = v2RemoteToolPolicy(mode, true, server, issuer);
    for (const action of [
      "read",
      "edit",
      "write",
      "shell",
      "bash",
      "glob",
      "grep",
      "skill",
      "subagent",
      "external_directory",
      "unknown_plugin",
      "bbv2_remote_another_read",
      `${server}_unknown`,
      `prefix_${server}_read`,
      `bb2_${"b".repeat(32)}_create_thread`,
    ])
      expect(v2PermissionEffect(policy, action, "/srv/project/file.ts"), action).toBe("deny");
    for (const tool of ["read", "list", "glob", "grep", "bash"])
      expect(v2PermissionEffect(policy, `${server}_${tool}`, "*"), tool).toBe(
        mode === "full-access" ? "allow" : "ask",
      );
    for (const tool of ["write", "edit", "apply_patch"])
      expect(v2PermissionEffect(policy, `${server}_${tool}`, "*"), tool).toBe(
        mode === "approval-required" ? "ask" : "allow",
      );
    for (const action of [
      "create_thread",
      "send_thread_message",
      "get_thread_status",
      "list_threads",
      "rename_thread",
    ]) {
      expect(v2PermissionEffect(policy, `bigbud_thread_v1_${action}`, "*")).toBe("allow");
      expect(v2PermissionEffect(policy, `bb2_${issuer.slice(0, 32)}_${action}`, "*")).toBe("allow");
    }
    expect(v2PermissionEffect(policy, "question", "*")).toBe("allow");
  },
);

it("tool-disabled hidden work has no remote, canonical or native execution authority", () => {
  const policy = v2RemoteToolPolicy("full-access", false, server, issuer);
  for (const action of [
    `${server}_read`,
    `${server}_bash`,
    `${server}_write`,
    "bigbud_thread_v1_create_thread",
    `bb2_${issuer.slice(0, 32)}_create_thread`,
    "question",
    "shell",
    "subagent",
  ])
    expect(v2PermissionEffect(policy, action, "*"), action).toBe("deny");
});

it("legacy ownership never grants another issuer's canonical tool family", () => {
  const policy = v2RemoteToolPolicy("full-access", true, server);
  expect(v2PermissionEffect(policy, "bigbud_thread_v1_create_thread", "*")).toBe("allow");
  expect(v2PermissionEffect(policy, `bb2_${issuer.slice(0, 32)}_create_thread`, "*")).toBe("deny");
});
