import {
  TerminalExecutionTargetError,
  type TerminalSessionSnapshot,
} from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetTerminalLaunch, readTerminalLaunch } from "../../lib/terminalLaunchBinding";
import {
  readTerminalLifecycle,
  useTerminalLifecycleStore,
} from "../../stores/terminal/terminalLifecycle.store";
import { fixture, fresh, host, old } from "./TerminalViewport.restart.profile.test.helpers";
beforeEach(() => useTerminalLifecycleStore.setState({ operations: {} }));
afterEach(() => {
  vi.useRealTimers();
  useTerminalLifecycleStore.setState({ operations: {} });
  forgetTerminalLaunch(old.threadId, old.terminalId);
});

describe("profile replacement through confirmed restart", () => {
  it("confirms destructive intent and sends profile with the existing generation/operation fence", async () => {
    const f = fixture();
    await f.action(f.replacement);
    expect(f.confirm).toHaveBeenCalledWith(
      expect.stringContaining("does not change the global default"),
    );
    expect(f.restart).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        shellSelection: { kind: "profile", profileId: "bash" },
        expectedGeneration: "old",
        operationId: expect.any(String),
        cwd: old.cwd,
        executionTargetId: old.executionTargetId,
        env: old.runtimeEnv,
      }),
    );
    expect(f.hydrate).toHaveBeenCalledOnce();
    // The selected request is not actual evidence; only the returned snapshot establishes that.
    expect(readTerminalLaunch(old.threadId, old.terminalId)?.shellLaunchIdentity?.profileId).toBe(
      "zsh",
    );
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
  });
  it("cancels without preparing delivery or sending a launch", async () => {
    const f = fixture();
    f.confirm.mockResolvedValue(false);
    await f.action(f.replacement);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.restart).not.toHaveBeenCalled();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
  });
  it.each(["generation", "pane", "host"])(
    "rejects stale %s before confirmation",
    async (change) => {
      const f = fixture();
      if (change === "generation") f.replacement.expectedGeneration = "stale";
      if (change === "pane") f.replacement.isCurrent = () => false;
      if (change === "host") f.replacement.profile.host = { kind: "local", hostId: "local" };
      await f.action(f.replacement);
      expect(f.confirm).not.toHaveBeenCalled();
      expect(f.restart).not.toHaveBeenCalled();
    },
  );
  it.each(["generation", "pane"])(
    "rechecks %s after confirmation and suppresses duplicate submits",
    async (change) => {
      const f = fixture();
      let approve!: (value: boolean) => void;
      f.confirm.mockImplementation(
        () =>
          new Promise((done) => {
            approve = done;
          }),
      );
      const pending = f.action(f.replacement);
      await f.action(f.replacement);
      expect(f.confirm).toHaveBeenCalledOnce();
      if (change === "generation") f.input.onSnapshot(fresh);
      else f.replacement.isCurrent = () => false;
      approve(true);
      await pending;
      expect(f.restart).not.toHaveBeenCalled();
      expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
    },
  );
  it("rechecks pane ownership after async delivery preparation", async () => {
    const f = fixture();
    f.prepare.mockImplementation(async () => {
      f.replacement.isCurrent = () => false;
      return { intake: { hydrate: f.hydrate, pause: vi.fn() } };
    });
    await f.action(f.replacement);
    expect(f.restart).not.toHaveBeenCalled();
  });
  it("does not retry an unknown launch through either replacement or ordinary restart", async () => {
    const f = fixture();
    f.restart.mockRejectedValueOnce(new Error("response lost"));
    await f.action(f.replacement);
    await f.action(f.replacement);
    await f.action();
    expect(f.restart).toHaveBeenCalledOnce();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.onFailure).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringContaining("still unconfirmed") }),
    );
  });
  it("keeps a timed-out operation owned and accepts its late result, without another launch", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (value: TerminalSessionSnapshot) => void;
    f.restart.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.action(f.replacement);
    await vi.advanceTimersByTimeAsync(20_001);
    await pending;
    await f.action(f.replacement);
    expect(f.restart).toHaveBeenCalledOnce();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)?.phase).toBe("error");
    resolve(fresh);
    await vi.advanceTimersByTimeAsync(0);
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
    expect(f.hydrate).toHaveBeenCalledOnce();
  });
  it("refreshes definitive stale-generation refusal without automatically replacing", async () => {
    const f = fixture();
    f.restart.mockRejectedValueOnce(
      new TerminalExecutionTargetError({
        threadId: old.threadId,
        terminalId: old.terminalId,
        executionTargetId: "ssh:profile",
        reason: "staleGeneration",
        detail: "Changed",
      }),
    );
    await f.action(f.replacement);
    expect(f.restart).toHaveBeenCalledOnce();
    expect(f.input.readSnapshot().runtimeGeneration).toBe("fresh");
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
    await f.action(f.replacement);
    expect(f.restart).toHaveBeenCalledOnce();
  });
  it("pins WSL distro from host evidence, never a changed default", async () => {
    const f = fixture();
    const wsl = {
      kind: "wsl",
      hostId: "wsl:pinned",
      distribution: "Pinned",
      username: "user",
    } as const;
    f.input.onSnapshot({
      ...old,
      executionTargetId: "wsl:ChangedDefault",
      shellLaunchIdentity: { ...old.shellLaunchIdentity!, host: wsl },
    });
    f.replacement.profile.host = wsl;
    await f.action(f.replacement);
    expect(f.restart).toHaveBeenCalledWith(
      expect.objectContaining({ executionTargetId: "wsl:Pinned", cwd: old.cwd }),
    );
  });
  it("ordinary restart preserves actual selection without turning unconfirmed requests into identity", async () => {
    const f = fixture();
    await f.action();
    expect(f.restart).toHaveBeenCalledWith(
      expect.objectContaining({ shellSelection: old.shellLaunchIdentity!.selection }),
    );
    f.input.onSnapshot({
      ...old,
      shellLaunchIdentity: undefined,
      shellUnconfirmedLaunch: {
        status: "unconfirmed",
        requestedProfile: { host, kind: "bash", profileId: "bash" },
      },
    });
    await f.action();
    expect(f.restart.mock.calls[1]?.[0]).not.toHaveProperty("shellSelection");
  });
});
