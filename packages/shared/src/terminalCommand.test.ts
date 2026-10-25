import { describe, expect, it } from "vitest";
import type {
  TerminalOpenInput,
  TerminalSessionSnapshot,
} from "@bigbud/contracts/workspace/terminal.ts";
import { assertTerminalCommandContext, terminalCommandContextMatches } from "./terminalCommand";

const expected: TerminalOpenInput = {
  threadId: "thread",
  terminalId: "script",
  cwd: "/project/worktree",
  worktreePath: "/project/worktree",
  executionTargetId: "ssh:project",
  env: { ROOT: "/project", WORKTREE: "/project/worktree" },
};
const snapshot: TerminalSessionSnapshot = {
  threadId: "thread",
  terminalId: "script",
  cwd: expected.cwd,
  worktreePath: expected.cwd,
  executionTargetId: expected.executionTargetId,
  runtimeEnv: expected.env,
  dropPathMode: "posix",
  status: "running",
  pid: 1,
  history: "",
  exitCode: null,
  exitSignal: null,
  updatedAt: "now",
};

describe("terminal command launch guard", () => {
  it("accepts the exact launch context with reordered environment keys", () => {
    expect(() =>
      assertTerminalCommandContext(
        { ...snapshot, runtimeEnv: { WORKTREE: expected.cwd, ROOT: "/project" } },
        expected,
      ),
    ).not.toThrow();
    expect(
      terminalCommandContextMatches(
        { cwd: "/home/user", executionTargetId: "local", worktreePath: null },
        { cwd: "/home/user" },
      ),
    ).toBe(true);
  });

  it("allows an explicitly requested Home rather than treating every Home launch as fallback", () => {
    expect(() =>
      assertTerminalCommandContext(
        { ...snapshot, cwd: "/home/user", worktreePath: null },
        { ...expected, cwd: "/home/user", worktreePath: null },
      ),
    ).not.toThrow();
  });

  it.each([
    { threadId: "other" },
    { terminalId: "other" },
    { cwd: "/old/worktree" },
    { worktreePath: null },
    { executionTargetId: "local" },
    { runtimeEnv: {} },
    { runtimeEnv: { ...expected.env, EXTRA: "old" } },
    { status: "exited" as const },
  ])("rejects unverified or mismatched returned context: %j", (changed) => {
    expect(() => assertTerminalCommandContext({ ...snapshot, ...changed }, expected)).toThrow(
      "Project commands were not run",
    );
  });

  it.each([
    "The requested folder does not exist",
    "The requested folder is inaccessible",
    "Folder resolution exceeded 10 seconds",
  ])("rejects %s fallback with actual Home and reason", (reason) => {
    expect(() =>
      assertTerminalCommandContext(
        {
          ...snapshot,
          cwd: "/home/remote",
          worktreePath: null,
          directoryFallback: { requestedCwd: expected.cwd, reason },
        },
        expected,
      ),
    ).toThrow(`${reason}: ${expected.cwd}. The terminal started in /home/remote`);
  });
});
