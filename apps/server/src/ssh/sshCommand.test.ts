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

  it("opts trusted probes into an absolute nonlogin shell with a clean environment", () => {
    const invocation = buildSshCommandInvocation({
      executionTargetId: "ssh:host=devbox&user=root&auth=ssh-key",
      shellMode: "clean-posix",
      command: "/usr/bin/env",
    });

    expect(invocation.args.at(-1)).toMatch(
      /^'\/usr\/bin\/env' '-i' 'PATH=\/usr\/bin:\/bin' 'LC_ALL=C' '\/bin\/sh' '-c' /,
    );
    expect(invocation.args.at(-1)).not.toContain("'-lc'");
    expect(invocation.args).toContain("BatchMode=yes");
    expect(invocation.args).toContain("-T");
  });

  it("can preserve the execution-account environment without an extra login wrapper", () => {
    const invocation = buildSshCommandInvocation({
      executionTargetId: "ssh:host=devbox&user=root&auth=ssh-key",
      shellMode: "non-login-posix",
      command: "/bin/zsh",
      args: ["-o", "nopromptsp"],
      allocateTty: true,
    });
    expect(invocation.args.at(-1)).toMatch(/^'\/bin\/sh' '-c' /);
    expect(invocation.args.at(-1)).not.toContain("'-lc'");
    expect(invocation.args.at(-1)).not.toContain("'-i'");
    expect(invocation.args).toContain("-tt");
  });

  it("does not place NUL bytes in process arguments", () => {
    const invocation = buildSshCommandInvocation({
      executionTargetId: "ssh:host=devbox&user=root&auth=ssh-key",
      cwd: "/root/project",
      command: "find",
      args: [".", "-printf", "%y\\t%P\\0"],
    });

    expect(invocation.args.some((argument) => argument.includes("\0"))).toBe(false);
  });
});
