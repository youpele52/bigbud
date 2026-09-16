import { describe, expect, it, vi } from "vitest";

import {
  makeRemoteAgentUpdateScheduler,
  REMOTE_AGENT_UPDATE_INTERVAL_MS,
} from "./remoteAgentUpdate.scheduler.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("remote agent update scheduler", () => {
  it("coalesces one target and never runs more than two checks", async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const scheduler = makeRemoteAgentUpdateScheduler({
      discoverTargets: async () => [],
      refreshSource: async () => undefined,
      check: async (target) => {
        started.push(target);
        const gate = deferred<void>();
        gates.set(`${target}-${started.length}`, gate);
        await gate.promise;
      },
    });

    scheduler.enqueue("one", "authenticated");
    scheduler.enqueue("one", "source-changed");
    scheduler.enqueue("two", "authenticated");
    scheduler.enqueue("three", "authenticated");
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(new Set(started)).toEqual(new Set(["one", "two"]));

    gates.get("one-1")!.resolve();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started[2]).toBe("one");
    gates.get("one-3")!.resolve();
    gates.get("two-2")!.resolve();
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(started[3]).toBe("three");
    gates.get("three-4")!.resolve();
    await scheduler.drain();
  });

  it("uses bounded symmetric jitter for recurring discovery", async () => {
    const delays: number[] = [];
    const scheduler = makeRemoteAgentUpdateScheduler({
      discoverTargets: async () => [],
      refreshSource: async () => undefined,
      check: async () => undefined,
      random: () => 0,
      setTimer: (callback, delay) => {
        delays.push(delay);
        return setTimeout(callback, 1_000_000);
      },
    });

    scheduler.start();
    await vi.waitFor(() => expect(delays).toHaveLength(1));
    expect(delays[0]).toBe(Math.round(REMOTE_AGENT_UPDATE_INTERVAL_MS * 0.9));
    scheduler.stop();
  });

  it("refreshes release metadata only on deliberate discovery", async () => {
    const refresh = vi.fn(async () => undefined);
    const checks = vi.fn(async () => undefined);
    const scheduler = makeRemoteAgentUpdateScheduler({
      discoverTargets: async () => ["ssh:known"],
      refreshSource: refresh,
      check: checks,
    });

    scheduler.enqueue("ssh:known", "authenticated");
    await scheduler.drain();
    expect(refresh).not.toHaveBeenCalled();
    await scheduler.refreshNow();
    await scheduler.drain();
    expect(refresh).toHaveBeenCalledOnce();
    expect(checks).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent source changes into one refresh and preparation", async () => {
    const release = deferred<void>();
    const refresh = vi.fn(async () => release.promise);
    const checks = vi.fn(async () => undefined);
    const scheduler = makeRemoteAgentUpdateScheduler({
      discoverTargets: async () => ["ssh:known"],
      refreshSource: refresh,
      check: checks,
    });

    const first = scheduler.refreshNow();
    const second = scheduler.refreshNow();
    expect(refresh).toHaveBeenCalledOnce();
    release.resolve();
    await Promise.all([first, second]);
    await scheduler.drain();

    expect(checks).toHaveBeenCalledOnce();
    await scheduler.refreshNow();
    await scheduler.drain();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(checks).toHaveBeenCalledTimes(2);
  });
});
