import { describe, expect, it, vi } from "vitest";

import {
  createWindowsHelperRunner,
  DEFAULT_WINDOWS_HELPER_TIMEOUTS,
  resolveWindowsHelperTimeouts,
  type WindowsHelperTimeouts,
} from "./windowsPowerShell.run";

type Step = { readonly durationMs: number; readonly error?: "timeout" | "spawn" };

function makeHarness(steps: Step[], overrides: Partial<WindowsHelperTimeouts> = {}) {
  let clockMs = 1_000;
  const sleep = vi.fn((ms: number) => {
    clockMs += ms;
  });
  const warn = vi.fn();
  const spawnSync = vi.fn((_command: string, _args: string[], options: { timeout: number }) => {
    const step = steps.shift() ?? { durationMs: 10 };
    clockMs += step.error === "timeout" ? options.timeout : step.durationMs;
    const error =
      step.error === "timeout"
        ? Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" })
        : step.error === "spawn"
          ? Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })
          : undefined;
    return {
      pid: 1,
      output: [],
      signal: error?.message.includes("ETIMEDOUT") ? "SIGTERM" : null,
      status: error ? null : 0,
      stdout: error ? "" : '{"status":"ok"}',
      stderr: "",
      ...(error ? { error } : {}),
    };
  });
  const runner = createWindowsHelperRunner({
    label: "Test helper",
    powerShell: {
      cwd: String.raw`C:\Windows`,
      env: { SystemRoot: String.raw`C:\Windows` },
      executablePath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    },
    timeouts: resolveWindowsHelperTimeouts("Test helper", overrides),
    spawnSync: spawnSync as never,
    clock: { now: () => clockMs, sleep, warn },
  });
  const run = () => runner.run({ script: "Write-Output 1", env: { BIGBUD_TEST: "1" } });
  const timeoutsPassed = () => spawnSync.mock.calls.map(([, , options]) => options.timeout);
  return { run, sleep, spawnSync, timeoutsPassed, warn };
}

describe("createWindowsHelperRunner", () => {
  it("defaults leave headroom over the measured 58s cold helper invocation", () => {
    expect(DEFAULT_WINDOWS_HELPER_TIMEOUTS.commandTimeoutMs).toBeGreaterThanOrEqual(90_000);
    expect(DEFAULT_WINDOWS_HELPER_TIMEOUTS.timeoutRetries).toBe(1);
    expect(DEFAULT_WINDOWS_HELPER_TIMEOUTS.totalTimeoutMs).toBe(180_000);
  });

  it("passes the controlled environment and a bounded hidden invocation", () => {
    const harness = makeHarness([{ durationMs: 30_000 }]);
    harness.run();
    const [, args, options] = harness.spawnSync.mock.calls[0]! as unknown as [
      string,
      string[],
      { env: Record<string, string>; windowsHide: boolean; timeout: number },
    ];
    expect(args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]));
    expect(options.env).toEqual({ SystemRoot: String.raw`C:\Windows`, BIGBUD_TEST: "1" });
    expect(options.windowsHide).toBe(true);
    expect(options.timeout).toBe(90_000);
  });

  it("retries a cold-start timeout once after backoff and returns the warm result", () => {
    const harness = makeHarness([{ durationMs: 0, error: "timeout" }, { durationMs: 20_000 }]);

    const result = harness.run();

    expect(result.error).toBeUndefined();
    expect(harness.spawnSync).toHaveBeenCalledTimes(2);
    expect(harness.sleep).toHaveBeenCalledWith(1_000);
    // The retry only gets what is left of the total budget: 180s - 90s - 1s backoff.
    expect(harness.timeoutsPassed()).toEqual([90_000, 89_000]);
    expect(harness.warn).toHaveBeenCalledOnce();
    expect(harness.warn.mock.calls[0]![0]).toBe(
      "[windows-helper] Test helper timed out after 90000ms (limit 90000ms, 90000ms elapsed); retrying in 1000ms.",
    );
  });

  it("fails with elapsed time and invocation count when the retry also times out", () => {
    const harness = makeHarness([
      { durationMs: 0, error: "timeout" },
      { durationMs: 0, error: "timeout" },
    ]);

    expect(() => harness.run()).toThrow(
      "Test helper exceeded its command timeout after 180000ms (2 invocation(s); last invocation ran 89000ms of its 89000ms limit; per-command limit 90000ms, total limit 180000ms).",
    );
    expect(harness.spawnSync).toHaveBeenCalledTimes(2);
  });

  it("does not retry when timeout retries are disabled", () => {
    const harness = makeHarness([{ durationMs: 0, error: "timeout" }], { timeoutRetries: 0 });

    expect(() => harness.run()).toThrow(
      "Test helper exceeded its command timeout after 90000ms (1 invocation(s);",
    );
    expect(harness.sleep).not.toHaveBeenCalled();
  });

  it("does not retry when the total budget cannot fit a retry", () => {
    const harness = makeHarness([{ durationMs: 0, error: "timeout" }], {
      commandTimeoutMs: 90_000,
      totalTimeoutMs: 90_500,
    });

    expect(() => harness.run()).toThrow("no budget left to retry");
    expect(harness.spawnSync).toHaveBeenCalledOnce();
  });

  it("returns non-timeout spawn errors to the caller without retrying", () => {
    const harness = makeHarness([{ durationMs: 5, error: "spawn" }]);

    const result = harness.run();

    expect((result.error as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(harness.spawnSync).toHaveBeenCalledOnce();
    expect(harness.sleep).not.toHaveBeenCalled();
  });

  it("shares one total budget and one retry across repeated runs", () => {
    const harness = makeHarness([
      { durationMs: 0, error: "timeout" },
      { durationMs: 60_000 },
      { durationMs: 0, error: "timeout" },
    ]);

    harness.run();
    expect(() => harness.run()).toThrow("exceeded its command timeout after 180000ms");
    expect(harness.timeoutsPassed()).toEqual([90_000, 89_000, 29_000]);
  });

  it("fails before spawning once the total budget is exhausted", () => {
    const harness = makeHarness([{ durationMs: 50 }], { totalTimeoutMs: 50 });

    harness.run();
    expect(() => harness.run()).toThrow("total budget exhausted");
    expect(harness.spawnSync).toHaveBeenCalledOnce();
  });

  it.each([
    { commandTimeoutMs: 0 },
    { totalTimeoutMs: 0 },
    { timeoutRetries: -1 },
    { retryBackoffMs: 1.5 },
  ])("rejects invalid timeout configuration %o", (overrides) => {
    expect(() => resolveWindowsHelperTimeouts("Test helper", overrides)).toThrow(
      "Test helper received invalid timeout configuration.",
    );
  });
});
