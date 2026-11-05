import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuardHandle, GuardState } from "./guardProcess";
import type { GuardExitReason } from "./guardProcess.logic";
import { superviseGuard } from "./guardProcess.supervisor";

/** A fake attempt that exits with `reason`, or runs until stopped. */
function fakeAttempt(reason: GuardExitReason | "run"): GuardHandle {
  let state: GuardState = { kind: "running", pid: 1 };
  let settle!: (value: GuardState) => void;
  const exited = new Promise<GuardState>((resolve) => {
    settle = resolve;
  });
  const exit = (why: GuardExitReason) => {
    state = { kind: "exited", reason: why, stderrTail: "" };
    settle(state);
  };
  if (reason !== "run") exit(reason);
  return {
    state: () => state,
    stop: async () => {
      if (state.kind === "running") exit("settled");
      return exited;
    },
    exited,
  };
}

function sequence(reasons: ReadonlyArray<GuardExitReason | "run">) {
  const queue = [...reasons];
  return vi.fn(() => fakeAttempt(queue.shift() ?? "run"));
}

const options = { binaryPath: "/guard", args: [], retryDelaysMs: [10, 20, 40] };

describe("superviseGuard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries an election conflict with backoff until the guard runs", async () => {
    // Regression (review P2): a relaunch conflict used to be final for the session.
    vi.useFakeTimers();
    const start = sequence(["conflict", "conflict", "run"]);
    const guard = superviseGuard({ ...options, start });
    await vi.advanceTimersByTimeAsync(0);
    expect(guard.state()).toEqual({ kind: "waiting", attempt: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(guard.state()).toEqual({ kind: "waiting", attempt: 2 });
    await vi.advanceTimersByTimeAsync(20);
    expect(start).toHaveBeenCalledTimes(3);
    expect(guard.state().kind).toBe("running");
    expect(await guard.stop()).toMatchObject({ kind: "exited", reason: "settled" });
  });

  it("never retries a non-conflict exit", async () => {
    const start = sequence(["storage"]);
    const guard = superviseGuard({ ...options, start });
    expect(await guard.exited).toMatchObject({ reason: "storage" });
    expect(start).toHaveBeenCalledOnce();
  });

  it("gives up after the retry budget and reports the conflict", async () => {
    vi.useFakeTimers();
    const start = sequence(["conflict", "conflict", "conflict", "conflict"]);
    const guard = superviseGuard({ ...options, start });
    await vi.advanceTimersByTimeAsync(100);
    expect(start).toHaveBeenCalledTimes(4);
    expect(await guard.exited).toMatchObject({ reason: "conflict" });
  });

  it("stop cancels a pending retry", async () => {
    vi.useFakeTimers();
    const start = sequence(["conflict", "run"]);
    const guard = superviseGuard({ ...options, start });
    await vi.advanceTimersByTimeAsync(0);
    expect(guard.state().kind).toBe("waiting");
    expect(await guard.stop()).toMatchObject({ reason: "conflict" });
    await vi.advanceTimersByTimeAsync(100);
    expect(start).toHaveBeenCalledOnce();
  });
});
