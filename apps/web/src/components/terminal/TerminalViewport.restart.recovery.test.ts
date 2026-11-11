import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetTerminalLaunch, recordTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { terminalProfileKey } from "../../lib/terminalProfileLaunch";
import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import {
  readTerminalLifecycle,
  useTerminalLifecycleStore,
} from "../../stores/terminal/terminalLifecycle.store";
import { terminalPersistenceOptions } from "../../stores/terminal/terminal.store.persistence";
import { toastManager } from "../ui/toast.manager";
import { terminalProfileOpenOptions } from "./TerminalViewport.profile";
import { fixture, fresh, host, old } from "./TerminalViewport.restart.profile.test.helpers";
import { prepareTerminalRestartDelivery } from "./TerminalViewport.restart.recovery";

vi.mock("../ui/toast.manager", () => ({ toastManager: { add: vi.fn() } }));
const refusal = () =>
  new TerminalExecutionTargetError({
    threadId: old.threadId,
    terminalId: old.terminalId,
    executionTargetId: old.executionTargetId!,
    reason: "restartNotStarted",
    detail: "Explicit profile was refused before stopping the shell",
  });
beforeEach(() => {
  vi.clearAllMocks();
  useTerminalLifecycleStore.setState({ operations: {} });
  useTerminalStateStore.setState({ terminalProfileLaunches: {} });
});
afterEach(() => {
  vi.useRealTimers();
  useTerminalLifecycleStore.setState({ operations: {} });
  forgetTerminalLaunch(old.threadId, old.terminalId);
});

describe("restoring an unmodified terminal after replacement refusal", () => {
  it("hydrates the snapshot-only attachment before unlocking a matched pre-stop refusal", async () => {
    const f = fixture();
    f.restart.mockRejectedValueOnce(refusal());
    f.snapshotRpc.mockResolvedValue(old);
    let hydrate!: () => void;
    f.hydrate.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          hydrate = done;
        }),
    );
    const pending = f.action(f.replacement);
    await vi.waitFor(() => expect(f.hydrate).toHaveBeenCalledExactlyOnceWith(old));
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeDefined();
    expect(f.snapshotRpc).toHaveBeenCalledExactlyOnceWith({
      threadId: old.threadId,
      terminalId: old.terminalId,
    });
    hydrate();
    await pending;
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.onFailure).not.toHaveBeenCalled();
    expect(toastManager.add).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    const first = f.restart.mock.calls[0]?.[0];
    await f.action(f.replacement);
    expect(f.restart).toHaveBeenCalledTimes(2);
    expect(f.restart.mock.calls[1]?.[0]).not.toEqual(first);
  });
  it.each(["generic", "message", "foreign"])(
    "keeps %s rejection fenced without inferring a pre-stop refusal",
    async (kind) => {
      const f = fixture();
      const error =
        kind === "message"
          ? new Error("restartNotStarted before stopping the shell")
          : new TerminalExecutionTargetError({
              threadId: kind === "foreign" ? "another-thread" : old.threadId,
              terminalId: old.terminalId,
              executionTargetId: old.executionTargetId!,
              ...(kind === "foreign" ? { reason: "restartNotStarted" as const } : {}),
              detail: "Profile rejected",
            });
      f.restart.mockRejectedValueOnce(error);
      await f.action(f.replacement);
      await f.action(f.replacement);
      expect(f.snapshotRpc).not.toHaveBeenCalled();
      expect(f.hydrate).not.toHaveBeenCalled();
      expect(f.restart).toHaveBeenCalledOnce();
      expect(readTerminalLifecycle(old.threadId, old.terminalId)?.phase).toBe("error");
    },
  );
  it.each(["snapshot", "mismatch", "generation", "stale", "hydrate"])(
    "does not unlock until %s restoration can be verified",
    async (failure) => {
      const f = fixture();
      f.restart.mockRejectedValueOnce(refusal());
      if (failure === "snapshot") f.snapshotRpc.mockRejectedValueOnce(new Error("Disconnected"));
      else if (failure === "mismatch")
        f.snapshotRpc.mockResolvedValueOnce({ ...old, terminalId: "other" });
      else if (failure === "generation")
        f.snapshotRpc.mockResolvedValueOnce({ ...old, runtimeGeneration: undefined });
      else if (failure === "stale") {
        recordTerminalLaunch(fresh);
        f.snapshotRpc.mockResolvedValueOnce(old);
      } else f.hydrate.mockRejectedValueOnce(new Error("Renderer failed"));
      await f.action(f.replacement);
      expect(readTerminalLifecycle(old.threadId, old.terminalId)?.phase).toBe("error");
      expect(f.onFailure).toHaveBeenCalledOnce();
      await f.action(f.replacement);
      expect(f.restart).toHaveBeenCalledOnce();
    },
  );
  it("does not hydrate or pause a superseding delivery when refusal snapshot arrives late", async () => {
    const f = fixture();
    f.restart.mockRejectedValueOnce(refusal());
    let resolve!: (snapshot: typeof old) => void;
    f.snapshotRpc.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.action(f.replacement);
    await vi.waitFor(() => expect(f.snapshotRpc).toHaveBeenCalledOnce());
    f.input.isCurrent = () => false;
    resolve(old);
    await pending;
    expect(f.hydrate).not.toHaveBeenCalled();
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.restart).toHaveBeenCalledOnce();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
  });
  it("leaves an exited original shell paused after a definite refusal, without opening a process", async () => {
    const f = fixture();
    f.restart.mockRejectedValueOnce(refusal());
    f.snapshotRpc.mockResolvedValueOnce({ ...old, status: "exited", pid: null });
    await f.action(f.replacement);
    expect(f.hydrate).not.toHaveBeenCalled();
    expect(f.pause).toHaveBeenCalledOnce();
    expect(f.input.readSnapshot().status).toBe("exited");
    expect(f.restart).toHaveBeenCalledOnce();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
  });
  it("persists the authoritative replacement outcome rather than replaying A after reload", async () => {
    const f = fixture();
    const key = terminalProfileKey(old.threadId, old.terminalId);
    useTerminalStateStore.setState({
      terminalProfileLaunches: {
        [key]: { host, shellSelection: { kind: "profile", profileId: "zsh" } },
      },
    });
    f.restart.mockResolvedValueOnce({
      ...fresh,
      shellLaunchIdentity: {
        ...fresh.shellLaunchIdentity!,
        selection: { kind: "profile", profileId: "bash" },
        profileId: "bash",
        kind: "bash",
      },
    });
    await f.action(f.replacement);
    const saved = terminalPersistenceOptions.partialize(useTerminalStateStore.getState());
    forgetTerminalLaunch(old.threadId, old.terminalId);
    useTerminalStateStore.setState(
      terminalPersistenceOptions.merge(saved, useTerminalStateStore.getState()),
    );
    expect(terminalProfileOpenOptions(old.threadId, old.terminalId)).toEqual({
      shellSelection: { kind: "profile", profileId: "bash" },
    });
  });
});

describe("replacement preparation without stranding the original live lane", () => {
  it("does not replace delivery when activation changes during subscription registration", async () => {
    const f = fixture();
    let registered!: () => void;
    const subscribe = vi.fn(
      () =>
        new Promise<void>((done) => {
          registered = done;
        }),
    );
    const replace = vi.fn(() => f.delivery);
    f.prepare.mockImplementation((isCurrent) =>
      prepareTerminalRestartDelivery(subscribe, replace, isCurrent!),
    );
    const pending = f.action(f.replacement);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    f.replacement.isCurrent = () => false;
    registered();
    await pending;
    expect(replace).not.toHaveBeenCalled();
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.snapshotRpc).not.toHaveBeenCalled();
    expect(f.pause).not.toHaveBeenCalled();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
  });
  it("restores a current replacement lane if activation changes just after preparation", async () => {
    const f = fixture();
    f.snapshotRpc.mockResolvedValueOnce(old);
    f.prepare.mockImplementationOnce(async () => {
      f.replacement.isCurrent = () => false;
      return f.delivery;
    });
    await f.action(f.replacement);
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.snapshotRpc).toHaveBeenCalledOnce();
    expect(f.hydrate).toHaveBeenCalledExactlyOnceWith(old);
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.onFailure).not.toHaveBeenCalled();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
  });
  it("does not dispose a newer delivery while restoring a cancelled preparation", async () => {
    const f = fixture();
    f.input.isCurrent = () => false;
    await f.action(f.replacement);
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.snapshotRpc).not.toHaveBeenCalled();
    expect(f.hydrate).not.toHaveBeenCalled();
    expect(f.pause).not.toHaveBeenCalled();
  });
  it("does not replace the old lane when registration resolves after its deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let registered!: () => void;
    const subscribe = () =>
      new Promise<void>((done) => {
        registered = done;
      });
    const replace = vi.fn(() => f.delivery);
    f.prepare.mockImplementation((isCurrent) =>
      prepareTerminalRestartDelivery(subscribe, replace, isCurrent!),
    );
    const pending = f.action(f.replacement);
    await vi.advanceTimersByTimeAsync(20_001);
    await pending;
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
    registered();
    await vi.advanceTimersByTimeAsync(0);
    expect(replace).not.toHaveBeenCalled();
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.pause).not.toHaveBeenCalled();
  });
});
