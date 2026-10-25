import type {
  TerminalOpenInput,
  TerminalSessionSnapshot,
} from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindTerminalLaunch,
  forgetTerminalLaunch,
  readTerminalLaunch,
} from "./terminalLaunchBinding";
import { runBoundTerminalCommand } from "./terminalLaunchBinding.command";

const desired: TerminalOpenInput = {
  threadId: "command-context",
  terminalId: "retained",
  cwd: "/project/worktree",
  worktreePath: "/project/worktree",
  executionTargetId: "ssh:project",
  env: { T3CODE_PROJECT_ROOT: "/project", T3CODE_WORKTREE_PATH: "/project/worktree" },
};

function snapshot(input: TerminalOpenInput): TerminalSessionSnapshot {
  return {
    threadId: input.threadId,
    terminalId: input.terminalId!,
    cwd: input.cwd,
    worktreePath: input.worktreePath ?? null,
    executionTargetId: input.executionTargetId,
    runtimeEnv: input.env ?? {},
    dropPathMode: "posix",
    status: "running",
    pid: 123,
    history: "retained output",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-11T00:00:00.000Z",
  };
}

function fixture(actual: (input: TerminalOpenInput) => TerminalSessionSnapshot = snapshot) {
  const terminal = {
    open: vi.fn(async (input: TerminalOpenInput) => actual(input)),
    write: vi.fn(async () => undefined),
  };
  const onTerminalSelected = vi.fn();
  const run = (overrides = {}) =>
    runBoundTerminalCommand(terminal, {
      openInput: desired,
      command: "bun run lint",
      preferNewTerminal: false,
      baseTerminalBusy: false,
      createTerminalId: () => "new-command",
      onTerminalSelected,
      ...overrides,
    });
  return { terminal, onTerminalSelected, run };
}

function bind(input: TerminalOpenInput) {
  return bindTerminalLaunch(input.threadId, input.terminalId!, {
    cwd: input.cwd,
    worktreePath: input.worktreePath,
    executionTargetId: input.executionTargetId,
    runtimeEnv: input.env,
  });
}

afterEach(() => {
  for (const id of ["retained", "new-command"]) forgetTerminalLaunch(desired.threadId, id);
});

describe("project command terminal selection and verified writes", () => {
  it.each([
    {
      name: "first-send worktree",
      origin: { cwd: "/project", worktreePath: null, env: { T3CODE_PROJECT_ROOT: "/project" } },
    },
    { name: "target", origin: { executionTargetId: "local" } },
    { name: "worktree identity", origin: { worktreePath: "/another/worktree" } },
    { name: "environment", origin: { env: { ...desired.env, EXTRA: "old" } } },
  ])(
    "preserves the idle old session and writes only to a new terminal on $name mismatch",
    async ({ origin }) => {
      const previous = bind({ ...desired, ...origin });
      const { terminal, onTerminalSelected, run } = fixture();
      await run();
      expect(terminal.open).toHaveBeenCalledExactlyOnceWith({
        ...desired,
        terminalId: "new-command",
      });
      expect(terminal.write).toHaveBeenCalledExactlyOnceWith({
        threadId: desired.threadId,
        terminalId: "new-command",
        data: "bun run lint\r",
      });
      expect(onTerminalSelected).toHaveBeenCalledWith(
        { ...desired, terminalId: "new-command" },
        true,
      );
      expect(readTerminalLaunch(desired.threadId, "retained")).toBe(previous);
    },
  );

  it("reuses a matching explicit launch, without claiming its launch cwd tracks manual cd", async () => {
    bind(desired);
    const { terminal, onTerminalSelected, run } = fixture();
    await run();
    expect(terminal.open).toHaveBeenCalledExactlyOnceWith(desired);
    expect(terminal.write).toHaveBeenCalledExactlyOnceWith({
      threadId: desired.threadId,
      terminalId: "retained",
      data: "bun run lint\r",
    });
    expect(onTerminalSelected).toHaveBeenCalledWith(desired, false);
  });

  it.each([{ preferNewTerminal: true }, { baseTerminalBusy: true }])(
    "honors explicit-new and busy-terminal selection: %j",
    async (options) => {
      bind(desired);
      const { terminal, run } = fixture();
      await run(options);
      expect(terminal.open.mock.calls[0]?.[0].terminalId).toBe("new-command");
    },
  );

  it("does not assume an unknown/restored binding has the requested environment", async () => {
    const { terminal, run } = fixture();
    await run();
    expect(terminal.open.mock.calls[0]?.[0].terminalId).toBe("new-command");
  });

  it("applies script dimensions only to new terminals, preserving matching reattachment sizing", async () => {
    bind(desired);
    const { terminal, run } = fixture();
    const newTerminalDimensions = { cols: 100, rows: 30 };
    await run({ newTerminalDimensions });
    expect(terminal.open.mock.calls[0]?.[0]).toEqual(desired);
    await run({ preferNewTerminal: true, newTerminalDimensions });
    expect(terminal.open.mock.calls[1]?.[0]).toEqual({
      ...desired,
      terminalId: "new-command",
      ...newTerminalDimensions,
    });
  });

  it.each([
    { cwd: "/old/project" },
    { executionTargetId: "local" },
    { worktreePath: null },
    { runtimeEnv: { T3CODE_PROJECT_ROOT: "/old/project" } },
    { runtimeEnv: undefined },
  ])(
    "rejects a returned reattachment mismatch without writing into either terminal: %j",
    async (changed) => {
      bind(desired);
      const { terminal, run } = fixture((input) => ({ ...snapshot(input), ...changed }));
      await expect(run()).rejects.toThrow("launch context does not match");
      expect(terminal.write).not.toHaveBeenCalled();
    },
  );

  it("leaves the fallback terminal available but refuses the project command in Home", async () => {
    const { terminal, run } = fixture((input) => ({
      ...snapshot(input),
      cwd: "/home/remote",
      worktreePath: null,
      runtimeEnv: {},
      directoryFallback: {
        requestedCwd: input.cwd,
        reason: "Folder resolution exceeded 10 seconds",
      },
    }));
    await expect(run()).rejects.toThrow("Project commands were not run in the fallback folder");
    expect(terminal.write).not.toHaveBeenCalled();
    expect(readTerminalLaunch(desired.threadId, "new-command")).toMatchObject({
      cwd: "/home/remote",
      executionTargetId: "ssh:project",
    });
  });
});
