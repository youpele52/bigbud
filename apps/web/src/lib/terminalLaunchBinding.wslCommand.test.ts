import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoundTerminalCommand } from "./terminalLaunchBinding.command";
import { bindTerminalLaunch, forgetTerminalLaunch } from "./terminalLaunchBinding";

const threadId = "manual-wsl-command";
const snapshot = (target: string, id: string): TerminalSessionSnapshot => ({
  threadId,
  terminalId: id,
  cwd: "C:\\project",
  worktreePath: null,
  runtimeEnv: {},
  executionTargetId: target,
  dropPathMode: "cmd",
  status: "running",
  pid: 123,
  history: "",
  exitCode: null,
  exitSignal: null,
  updatedAt: "now",
});
afterEach(() => {
  forgetTerminalLaunch(threadId, "base");
  forgetTerminalLaunch(threadId, "new");
});

describe("project commands never reuse a manual WSL terminal", () => {
  const commandInput = () => ({
    openInput: {
      threadId,
      terminalId: "base",
      executionTargetId: "local",
      cwd: "C:\\project",
      env: {},
    },
    command: "project command",
    preferNewTerminal: false,
    baseTerminalBusy: false,
    createTerminalId: () => "new",
    onTerminalSelected: vi.fn(),
  });
  it("opens a new workspace-target terminal instead of a retained WSL binding", async () => {
    bindTerminalLaunch(threadId, "base", {
      cwd: "/mapped/project",
      executionTargetId: "wsl:Ubuntu",
    });
    const terminal = {
      open: vi.fn(async () => snapshot("local", "new")),
      write: vi.fn(async () => undefined),
    };
    await runBoundTerminalCommand(terminal, commandInput());
    expect(terminal.open).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "new", executionTargetId: "local" }),
    );
    expect(terminal.write).toHaveBeenCalledWith(expect.objectContaining({ terminalId: "new" }));
  });
  it("fails closed on server-reported WSL identity after reconnect even if client binding was local", async () => {
    bindTerminalLaunch(threadId, "base", {
      cwd: "C:\\project",
      executionTargetId: "local",
      runtimeEnv: {},
    });
    const terminal = {
      open: vi.fn(async () => snapshot("wsl:Ubuntu", "base")),
      write: vi.fn(async () => undefined),
    };
    await expect(runBoundTerminalCommand(terminal, commandInput())).rejects.toThrow(
      "does not match",
    );
    expect(terminal.write).not.toHaveBeenCalled();
  });
});
