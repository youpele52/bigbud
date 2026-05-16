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
      "-o",
      "IdentitiesOnly=yes",
      "-p",
      "22",
      "-i",
      expect.stringContaining(".ssh/open_stack"),
      "root@46.225.127.53",
      expect.stringContaining("'codex' 'app-server'"),
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
