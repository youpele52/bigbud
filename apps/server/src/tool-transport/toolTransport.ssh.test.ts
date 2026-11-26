import type { ExecutionTargetId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  SelectedProviderWorkspaceShell,
  SelectedProviderWorkspaceShellInput,
} from "../ws/remoteWorkspaceProviderShell.ts";
import { runSshToolCommand, SelectedSshToolTransportError } from "./toolTransport.ssh.ts";

const executionTargetId = "ssh:host=devbox&user=dev" as ExecutionTargetId;
const cwd = "/srv/project";

function fakeShell(result = { output: "ok\n", exitCode: 0, truncated: false, timedOut: false }) {
  const runs: SelectedProviderWorkspaceShellInput[] = [];
  const shellFor = vi.fn(
    (targetId: string, workspaceRoot: string): SelectedProviderWorkspaceShell => ({
      targetId,
      workspaceRoot,
      run: async (input) => {
        runs.push(input);
        return result;
      },
    }),
  );
  return { runs, shellFor };
}

describe("W7 generic SSH tool commands over the provider shell grant", () => {
  it("runs exactly `sh -lc <text>` in the workspace root through the owner grant", async () => {
    const { runs, shellFor } = fakeShell();
    const result = await runSshToolCommand(
      {
        executionTargetId,
        invocationId: "copilot-tool:s:1",
        cwd,
        command: "sh",
        args: ["-lc", "npm test"],
        timeoutMs: 600_000,
      },
      shellFor,
    );
    expect(shellFor).toHaveBeenCalledWith(executionTargetId, cwd);
    expect(runs).toEqual([
      {
        workspaceRoot: cwd,
        cwd,
        provider: "thread-tool",
        sessionId: "copilot-tool:s:1",
        invocationId: "copilot-tool:s:1",
        command: "npm test",
        timeoutMs: 120_000,
      },
    ]);
    expect(result).toEqual({ stdout: "ok\n", stderr: "", code: 0, signal: null, timedOut: false });
  });

  it("refuses every other shape before dispatch", async () => {
    const { shellFor } = fakeShell();
    const base = { executionTargetId, cwd, command: "sh", args: ["-lc", "ls"] } as const;
    for (const input of [
      { ...base, command: "git", args: ["status"] },
      { ...base, args: ["-c", "ls"] },
      { ...base, stdin: "data" },
      { ...base, allocateTty: true },
      { ...base, env: { TOKEN: "x" } },
      { ...base, cwd: undefined },
      { ...base, cwd: "relative" },
      { ...base, cwd: "/" },
    ]) {
      await expect(runSshToolCommand(input, shellFor)).rejects.toBeInstanceOf(
        SelectedSshToolTransportError,
      );
    }
    expect(shellFor).not.toHaveBeenCalled();
  });

  it("maps exit codes, timeouts and output bounds without replaying", async () => {
    const failing = fakeShell({ output: "no", exitCode: 2, truncated: false, timedOut: false });
    const input = { executionTargetId, cwd, command: "sh", args: ["-lc", "false"] };
    await expect(runSshToolCommand(input, failing.shellFor)).rejects.toThrow("code 2");
    await expect(
      runSshToolCommand({ ...input, allowNonZeroExit: true }, failing.shellFor),
    ).resolves.toMatchObject({ code: 2, stdout: "no" });
    const timedOut = fakeShell({ output: "", exitCode: 124, truncated: false, timedOut: true });
    await expect(
      runSshToolCommand({ ...input, allowNonZeroExit: true }, timedOut.shellFor),
    ).rejects.toThrow("timed out");
    expect(timedOut.runs).toHaveLength(1);
    const large = fakeShell({ output: "abcdef", exitCode: 0, truncated: false, timedOut: false });
    await expect(
      runSshToolCommand({ ...input, maxBufferBytes: 3 }, large.shellFor),
    ).rejects.toThrow("buffer limit");
    await expect(
      runSshToolCommand({ ...input, maxBufferBytes: 3, outputMode: "truncate" }, large.shellFor),
    ).resolves.toMatchObject({ stdout: "abc", stdoutTruncated: true });
    const first = fakeShell();
    await runSshToolCommand(input, first.shellFor);
    await runSshToolCommand(input, first.shellFor);
    expect(first.runs[0]!.invocationId).not.toBe(first.runs[1]!.invocationId);
  });
});
