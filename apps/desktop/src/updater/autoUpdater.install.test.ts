import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createUpdateInstallCoordinator,
  handleUpdateHandoffAccepted,
  RestartRequiredUpdatePreparationError,
  type UpdateInstallCoordinatorDeps,
} from "./autoUpdater.install";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeHarness(
  platform: NodeJS.Platform = "darwin",
  overrides: Partial<UpdateInstallCoordinatorDeps> = {},
) {
  const state = { canInstall: true, installing: false, quitting: false };
  const handoffFailures: string[] = [];
  const restartRequiredFailures: string[] = [];
  const quitTransitions: boolean[] = [];
  const events: string[] = [];
  const quitAndInstall = vi.fn(() => {
    events.push("handoff");
  });
  const deps: UpdateInstallCoordinatorDeps = {
    beginUpdatePreparation: vi.fn(() => events.push("quiesce")),
    canInstall: () => state.canInstall,
    clearUpdateTimers: vi.fn(),
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    getIsQuitting: () => state.quitting,
    onHandoffFailure: (message) => {
      state.canInstall = false;
      state.installing = false;
      handoffFailures.push(message);
    },
    onInstallStart: () => {
      state.installing = true;
      events.push("installing");
    },
    onRestartRequiredPreparationFailure: (message) => {
      state.canInstall = false;
      state.installing = false;
      restartRequiredFailures.push(message);
    },
    platform,
    prepareForUpdateInstall: vi.fn(async () => {
      events.push("cleanup");
    }),
    quitAndInstall,
    setIsQuitting: (value) => {
      state.quitting = value;
      quitTransitions.push(value);
    },
    ...overrides,
  };
  return {
    coordinator: createUpdateInstallCoordinator(deps),
    deps,
    events,
    handoffFailures,
    quitTransitions,
    restartRequiredFailures,
    quitAndInstall,
    state,
  };
}

describe("update install coordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes clicks and completes cleanup strictly before updater handoff", async () => {
    const cleanup = deferred();
    const harness = makeHarness("darwin", {
      prepareForUpdateInstall: vi.fn(() => cleanup.promise),
    });

    const first = harness.coordinator.install();
    const duplicate = await harness.coordinator.install();
    expect(duplicate.accepted).toBe(false);
    expect(harness.quitAndInstall).not.toHaveBeenCalled();

    harness.events.push("cleanup complete");
    cleanup.resolve();
    await first;

    expect(harness.events).toEqual(["quiesce", "cleanup complete", "installing", "handoff"]);
  });

  it("makes cleanup failure restart-required and never launches the updater", async () => {
    const prepare = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("CUA still live"));
    const harness = makeHarness("darwin", { prepareForUpdateInstall: prepare });

    const failed = await harness.coordinator.install();

    expect(failed.accepted).toBe(true);
    expect(harness.restartRequiredFailures).toEqual([
      "CUA still live Restart bigbud before trying to install again.",
    ]);
    expect(harness.state.quitting).toBe(false);
    expect(harness.quitAndInstall).not.toHaveBeenCalled();

    prepare.mockResolvedValueOnce();
    expect((await harness.coordinator.install()).accepted).toBe(false);
    expect(harness.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not claim the quit state or hand off when a normal quit wins the race", async () => {
    const cleanup = deferred();
    const harness = makeHarness("darwin", {
      prepareForUpdateInstall: () => cleanup.promise,
    });
    const resultPromise = harness.coordinator.install();
    harness.state.quitting = true;
    cleanup.resolve();
    const result = await resultPromise;

    expect(result.accepted).toBe(true);
    expect(harness.state.quitting).toBe(true);
    expect(harness.quitAndInstall).not.toHaveBeenCalled();
    expect(harness.state.installing).toBe(false);
  });

  it.each([
    ["win32", [true, true]],
    ["darwin", []],
    ["linux", []],
  ] as const)("preserves %s updater arguments", async (platform, expectedArguments) => {
    const harness = makeHarness(platform);

    await harness.coordinator.install();

    expect(harness.quitAndInstall).toHaveBeenCalledWith(...expectedArguments);
  });

  it("requires an app restart when quitAndInstall throws after handoff invocation", async () => {
    const harness = makeHarness("win32", {
      quitAndInstall: vi.fn(() => {
        throw new Error("NSIS launch failed");
      }),
    });

    await harness.coordinator.install();

    expect(harness.handoffFailures).toEqual([
      "NSIS launch failed Restart bigbud before trying to install again.",
    ]);
    expect(harness.state.quitting).toBe(true);
    expect(harness.state.installing).toBe(false);
  });

  it("requires restart without clearing quit state after the Windows fallback", async () => {
    const harness = makeHarness("win32");

    await harness.coordinator.install();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.handoffFailures).toEqual([
      "The updater did not complete the restart. Restart bigbud before trying to install again.",
    ]);
    expect(harness.state.quitting).toBe(true);
    expect(harness.quitTransitions).toEqual([true]);
    expect(harness.coordinator.isInFlight()).toBe(false);
    expect((await harness.coordinator.install()).accepted).toBe(false);
    expect(harness.coordinator.handleUpdaterError(new Error("late updater error"))).toBe(true);
  });

  it.each(["win32", "darwin", "linux"] as const)(
    "requires restart when the %s updater errors after handoff",
    async (platform) => {
      const harness = makeHarness(platform);
      await harness.coordinator.install();

      expect(harness.coordinator.handleUpdaterError(new Error("updater failed"))).toBe(true);

      expect(harness.handoffFailures).toEqual([
        "updater failed Restart bigbud before trying to install again.",
      ]);
      expect(harness.state.quitting).toBe(true);
    },
  );

  it("does not infer macOS handoff failure from elapsed wall-clock time", async () => {
    const harness = makeHarness("darwin");

    await harness.coordinator.install();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.handoffFailures).toEqual([]);
    expect(harness.state.quitting).toBe(true);
    expect(harness.coordinator.isInFlight()).toBe(true);

    harness.coordinator.markHandoffAccepted();
    expect(harness.coordinator.isInFlight()).toBe(false);
    expect((await harness.coordinator.install()).accepted).toBe(false);
  });

  it("makes the Linux handoff timer restart-required and nonretryable", async () => {
    const harness = makeHarness("linux");

    await harness.coordinator.install();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.handoffFailures).toEqual([
      "The updater did not complete the restart. Restart bigbud before trying to install again.",
    ]);
    expect(harness.quitTransitions).toEqual([true]);
    expect((await harness.coordinator.install()).accepted).toBe(false);
  });

  it.each(["darwin", "linux"] as const)(
    "requires restart when quitAndInstall throws on %s",
    async (platform) => {
      const harness = makeHarness(platform, {
        quitAndInstall: vi.fn(() => {
          throw new Error("platform handoff failed");
        }),
      });

      await harness.coordinator.install();

      expect(harness.handoffFailures).toEqual([
        "platform handoff failed Restart bigbud before trying to install again.",
      ]);
      expect(harness.state.quitting).toBe(true);
      expect(harness.quitTransitions).toEqual([true]);
      expect((await harness.coordinator.install()).accepted).toBe(false);
    },
  );

  it("cancels handoff when an updater error arrives during deferred cleanup", async () => {
    const cleanup = deferred();
    const harness = makeHarness("darwin", { prepareForUpdateInstall: () => cleanup.promise });
    const installing = harness.coordinator.install();

    expect(harness.coordinator.handleUpdaterError(new Error("download invalidated"))).toBe(true);
    cleanup.resolve();
    await installing;

    expect(harness.restartRequiredFailures).toEqual([
      "download invalidated Restart bigbud before trying to install again.",
    ]);
    expect(harness.quitAndInstall).not.toHaveBeenCalled();
    expect(harness.state.quitting).toBe(false);
  });

  it("rechecks update eligibility after deferred cleanup", async () => {
    const cleanup = deferred();
    const harness = makeHarness("darwin", { prepareForUpdateInstall: () => cleanup.promise });
    const installing = harness.coordinator.install();
    harness.state.canInstall = false;
    cleanup.resolve();

    await installing;

    expect(harness.restartRequiredFailures).toEqual([
      "The downloaded update is no longer eligible for installation. Restart bigbud before trying to install again.",
    ]);
    expect(harness.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not advertise retry for restart-required preparation failure", async () => {
    const harness = makeHarness("win32", {
      prepareForUpdateInstall: vi.fn(async () => {
        throw new RestartRequiredUpdatePreparationError("Windows process tree is uncertain.");
      }),
    });

    await harness.coordinator.install();

    expect(harness.restartRequiredFailures).toEqual([
      "Windows process tree is uncertain. Restart bigbud before trying to install again.",
    ]);
    expect(harness.quitAndInstall).not.toHaveBeenCalled();
    expect((await harness.coordinator.install()).accepted).toBe(false);
  });

  it("marks handoff accepted before final teardown and cancels the fallback timer", async () => {
    const harness = makeHarness("win32");
    await harness.coordinator.install();

    handleUpdateHandoffAccepted(harness.coordinator, () => {
      harness.events.push(
        harness.coordinator.isInFlight() ? "pending teardown" : "accepted teardown",
      );
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.events.at(-1)).toBe("accepted teardown");
    expect(harness.handoffFailures).toEqual([]);
  });
});
