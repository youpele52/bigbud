import { describe, expect, it } from "vitest";

import { buildSshCommandInvocation } from "./sshCommand.ts";

describe("buildSshCommandInvocation", () => {
  it("forces IdentitiesOnly when an explicit key path is provided", () => {
    const invocation = buildSshCommandInvocation({
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key&keyPath=%7E%2F.ssh%2Fid",
      cwd: "/root/project",
      command: "pwd",
    });

    expect(invocation.command).toBe("ssh");
    expect(invocation.args).toContain("IdentitiesOnly=yes");
  });

  it("does not add IdentitiesOnly without an explicit key path", () => {
    const invocation = buildSshCommandInvocation({
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      cwd: "/root/project",
      command: "pwd",
    });

    expect(invocation.args).not.toContain("IdentitiesOnly=yes");
  });

  it("wraps the remote command as one shell-escaped argument", () => {
    const invocation = buildSshCommandInvocation({
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      cwd: "/root/project",
      command: "printf",
      args: ["hello world"],
    });

    expect(invocation.args.at(-1)).toBe(
      "'sh' '-lc' 'if [ -n \"$1\" ]; then cd \"$1\" || exit 1; fi; shift; while [ \"$#\" -gt 0 ] && [ \"$1\" != \"--\" ]; do export \"$1\"; shift; done; shift; exec \"$@\"' 'sh' '/root/project' '--' 'printf' 'hello world'",
    );
  });
});
