import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { buildRemoteCodexSshInvocation } from "./codexAppServerManager.process.remote.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

describe("buildRemoteCodexSshInvocation", () => {
  it("builds an ssh-key codex app-server invocation from the execution target", () => {
    const invocation = buildRemoteCodexSshInvocation(
      {
        threadId: asThreadId("thread-1"),
        provider: "codex",
        executionTargetId:
          "ssh:host=46.225.127.53&user=root&port=22&auth=ssh-key&keyPath=%7E%2F.ssh%2Fopen_stack",
        cwd: "/root/project",
        runtimeMode: "full-access",
        binaryPath: "codex",
        homePath: "/root/.codex",
      },
      ["app-server"],
    );

    expect(invocation.command).toBe("ssh");
    expect(invocation.args).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-p",
      "22",
      "-i",
      expect.stringContaining(".ssh/open_stack"),
      "root@46.225.127.53",
      "sh",
      "-lc",
      'if [ -n "$1" ]; then cd "$1" || exit 1; fi; shift; while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do export "$1"; shift; done; shift; exec "$@"',
      "sh",
      "/root/project",
      "CODEX_HOME=/root/.codex",
      "--",
      "codex",
      "app-server",
    ]);
  });

  it("rejects password ssh auth", () => {
    expect(() =>
      buildRemoteCodexSshInvocation(
        {
          threadId: asThreadId("thread-1"),
          provider: "codex",
          executionTargetId: "ssh:host=46.225.127.53&user=root&auth=password",
          cwd: "/root/project",
          runtimeMode: "full-access",
          binaryPath: "codex",
        },
        ["app-server"],
      ),
    ).toThrow("Password SSH authentication is not supported for remote execution yet.");
  });
});
