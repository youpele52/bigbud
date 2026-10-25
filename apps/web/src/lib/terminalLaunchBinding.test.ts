import { describe, expect, it } from "vitest";
import {
  bindTerminalLaunch,
  forgetTerminalLaunch,
  recordTerminalLaunch,
} from "./terminalLaunchBinding";

describe("per-terminal launch bindings", () => {
  it("preserves the launch target, folder, and environment across first-send and workspace mutations", () => {
    const first = bindTerminalLaunch("origin", "bottom", {
      cwd: "/origin/worktree",
      worktreePath: "/origin/worktree",
      executionTargetId: "ssh:origin",
      runtimeEnv: { ROOT: "/origin" },
    });
    expect(
      bindTerminalLaunch("origin", "bottom", {
        cwd: "/new",
        executionTargetId: "local",
        runtimeEnv: { ROOT: "/new" },
      }),
    ).toBe(first);
    expect(
      bindTerminalLaunch("origin", "right", { cwd: "/other", executionTargetId: "local" }).cwd,
    ).toBe("/other");
    expect(bindTerminalLaunch("origin", "new", { cwd: "/new/worktree" }).cwd).toBe("/new/worktree");
    for (const id of ["bottom", "right", "new"]) forgetTerminalLaunch("origin", id);
  });

  it("reattaches to the actual launch directory after Home fallback without setup environment", () => {
    bindTerminalLaunch("fallback", "bottom", {
      cwd: "/missing",
      worktreePath: "/missing",
      runtimeEnv: { ROOT: "/missing" },
    });
    recordTerminalLaunch({
      threadId: "fallback",
      terminalId: "bottom",
      cwd: "/home/remote",
      worktreePath: null,
      executionTargetId: "ssh:remote",
      status: "running",
      pid: 1,
      dropPathMode: "posix",
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "now",
      directoryFallback: { requestedCwd: "/missing", reason: "missing" },
    });
    expect(bindTerminalLaunch("fallback", "bottom", { cwd: "/new" })).toMatchObject({
      cwd: "/home/remote",
      worktreePath: null,
      executionTargetId: "ssh:remote",
      runtimeEnv: undefined,
    });
    forgetTerminalLaunch("fallback", "bottom");
    expect(bindTerminalLaunch("fallback", "bottom", { cwd: "/explicit-new" }).cwd).toBe(
      "/explicit-new",
    );
    forgetTerminalLaunch("fallback", "bottom");
  });
});
