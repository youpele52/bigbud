import { afterEach, expect, it } from "vitest";
import {
  bindTerminalLaunch,
  forgetTerminalLaunch,
  readTerminalLaunch,
} from "./terminalLaunchBinding";
import { captureTerminalProfileLaunch } from "./terminalProfileLaunch";

const thread = "new-target-test";
const pane = "source";
const host = { kind: "ssh", hostId: "ssh:original" } as const;
const selection = { kind: "profile", profileId: "original-zsh" } as const;
const bind = () =>
  bindTerminalLaunch(thread, pane, {
    cwd: "/original/project",
    worktreePath: "/original/project",
    executionTargetId: host.hostId,
    runtimeEnv: { PROJECT_ROOT: "/original/project" },
    runtimeGeneration: "original",
    updatedAt: "confirmed",
    shellLaunchIdentity: {
      host,
      selection,
      profileId: selection.profileId,
      kind: "zsh",
      integration: { status: "disabled" },
    },
  });
afterEach(() => forgetTerminalLaunch(thread, pane));

it("uses the newly selected host's default without borrowing source profile authority", () => {
  const original = bind();
  const launched = captureTerminalProfileLaunch(thread, pane, {
    newExecutionTargetId: "wsl:Ubuntu",
  });
  expect(launched).toEqual({
    context: {
      cwd: "/original/project",
      worktreePath: "/original/project",
      executionTargetId: "wsl:Ubuntu",
      runtimeEnv: { PROJECT_ROOT: "/original/project" },
    },
  });
  expect(launched.shellSelection).toBeUndefined();
  expect(launched.host).toBeUndefined();
  expect(readTerminalLaunch(thread, pane)).toBe(original);
  expect(launched.context?.runtimeEnv).not.toBe(original.runtimeEnv);
});
it("inherits actual profile on the same target and permits explicit workspace return", () => {
  bind();
  expect(
    captureTerminalProfileLaunch(thread, pane, { newExecutionTargetId: host.hostId }),
  ).toMatchObject({ host, shellSelection: selection });
  expect(
    captureTerminalProfileLaunch(thread, pane, { newExecutionTargetId: "local" }),
  ).toMatchObject({ context: { executionTargetId: "local" } });
});
it("does not borrow context when the source is missing or combine host changes with exact profiles", () => {
  expect(() =>
    captureTerminalProfileLaunch(thread, pane, { newExecutionTargetId: "local" }),
  ).toThrow("context");
  bind();
  expect(() =>
    captureTerminalProfileLaunch(thread, pane, {
      newExecutionTargetId: "local",
      host,
      shellSelection: selection,
    }),
  ).toThrow("separately");
});
it("keeps Automatic recovery on its original host despite an injected context", () => {
  bind();
  expect(
    captureTerminalProfileLaunch(thread, pane, {
      shellSelection: { kind: "legacy-auto" },
      context: { cwd: "/wrong", executionTargetId: "wsl:wrong" },
    }),
  ).toMatchObject({ context: { cwd: "/original/project", executionTargetId: host.hostId } });
});
