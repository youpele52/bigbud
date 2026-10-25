import { afterEach, describe, expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts";
import { useTerminalStateStore } from "./terminal.store";
import { resolveManualTerminalTarget } from "./terminal.store.wsl";
import { parseWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import {
  bindTerminalLaunch,
  forgetTerminalLaunch,
  recordTerminalLaunch,
  readTerminalLaunch,
} from "../../lib/terminalLaunchBinding";

const threadId = ThreadId.makeUnsafe("wsl-selection");
afterEach(() => {
  useTerminalStateStore.getState().setTerminalWslDistribution(threadId, null);
  forgetTerminalLaunch(threadId, "manual");
});

describe("manual-only WSL selection", () => {
  it("affects new manual launches in a local chat without changing its workspace target", () => {
    useTerminalStateStore.getState().setTerminalWslDistribution(threadId, "Ubuntu dev");
    const selected = useTerminalStateStore.getState().terminalWslDistributionByThreadId[threadId];
    expect(resolveManualTerminalTarget("local", selected)).toBe("wsl:Ubuntu%20dev");
    expect(resolveManualTerminalTarget("ssh:host=box", selected)).toBe("ssh:host=box");
    expect(resolveManualTerminalTarget(undefined, undefined)).toBeUndefined();
  });
  it.each(["", " invalid ", "invalid\0name", "invalid\ud800", "invalid\udfff", null, 123])(
    "fails closed for corrupt persisted selection %j even if a sentinel-named distro exists",
    (saved) => {
      const target = resolveManualTerminalTarget("local", saved as string);
      expect(target).not.toBe("local");
      expect(parseWslTerminalTargetId(target)).toBeNull();
    },
  );
  it("persists only distro selection, never resolved account or Home", () => {
    useTerminalStateStore.getState().setTerminalWslDistribution(threadId, "Ubuntu");
    const persisted = useTerminalStateStore.persist.getOptions().partialize!(
      useTerminalStateStore.getState(),
    );
    expect(persisted).toMatchObject({
      terminalWslDistributionByThreadId: { [threadId]: "Ubuntu" },
    });
    expect(JSON.stringify(persisted)).not.toContain("wslIdentity");
    expect(JSON.stringify(persisted)).not.toContain("HOME");
  });
  it("running launch identity cannot change with the per-chat preference", () => {
    bindTerminalLaunch(threadId, "manual", { cwd: "/home/alice", executionTargetId: "wsl:Ubuntu" });
    useTerminalStateStore.getState().setTerminalWslDistribution(threadId, "Other");
    expect(
      bindTerminalLaunch(threadId, "manual", { cwd: "/home/bob", executionTargetId: "wsl:Other" })
        .executionTargetId,
    ).toBe("wsl:Ubuntu");
  });
  it("cleans deleted/orphaned selections while keeping active chats", () => {
    const state = useTerminalStateStore.getState();
    state.setTerminalWslDistribution(threadId, "Ubuntu");
    state.removeOrphanedTerminalStates(new Set([threadId]));
    expect(useTerminalStateStore.getState().terminalWslDistributionByThreadId[threadId]).toBe(
      "Ubuntu",
    );
    state.removeOrphanedTerminalStates(new Set());
    expect(
      useTerminalStateStore.getState().terminalWslDistributionByThreadId[threadId],
    ).toBeUndefined();
  });
  it("records actual server user without persisting it", () => {
    recordTerminalLaunch({
      threadId,
      terminalId: "manual",
      cwd: "/root",
      executionTargetId: "wsl:Ubuntu",
      wslIdentity: { distribution: "Ubuntu", username: "root", uid: 0 },
      worktreePath: null,
      dropPathMode: "posix",
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "now",
    });
    expect(readTerminalLaunch(threadId, "manual")?.wslIdentity?.username).toBe("root");
    expect(
      JSON.stringify(
        useTerminalStateStore.persist.getOptions().partialize!(useTerminalStateStore.getState()),
      ),
    ).not.toContain("username");
  });
  it("replaces captured identity on restart and clears it on a local launch", () => {
    const snapshot = {
      threadId,
      terminalId: "manual",
      cwd: "/home/alice",
      executionTargetId: "wsl:Ubuntu",
      worktreePath: null,
      dropPathMode: "posix" as const,
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "now",
    };
    recordTerminalLaunch({
      ...snapshot,
      wslIdentity: { distribution: "Ubuntu", username: "alice", uid: 1000 },
    });
    const nextIdentity = { distribution: "Ubuntu", username: "bob", uid: 1001 };
    recordTerminalLaunch({ ...snapshot, cwd: "/home/bob", wslIdentity: nextIdentity });
    expect(readTerminalLaunch(threadId, "manual")?.wslIdentity).toEqual(nextIdentity);
    recordTerminalLaunch({ ...snapshot, executionTargetId: "local" });
    expect(readTerminalLaunch(threadId, "manual")?.wslIdentity).toBeUndefined();
  });
  it("removes a deleted chat's selection even before its first terminal opens", () => {
    useTerminalStateStore.getState().setTerminalWslDistribution(threadId, "Ubuntu");
    useTerminalStateStore.getState().removeTerminalState(threadId);
    expect(
      useTerminalStateStore.getState().terminalWslDistributionByThreadId[threadId],
    ).toBeUndefined();
  });
});
