import { describe, expect, it, vi } from "vitest";

import {
  sweepWindowsCuaDriverProcesses,
  WINDOWS_CUA_SWEEP_SCRIPT,
  windowsExecutablePathsEqual,
} from "./cuaDriver.windowsSweep";

function commandResult(input: {
  readonly status?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: Error;
}) {
  return {
    pid: 42,
    output: [],
    signal: null,
    status: input.status ?? 0,
    stdout: input.stdout ?? JSON.stringify({ status: "ok", matched: 0, terminated: 0, raced: 0 }),
    stderr: input.stderr ?? "",
    ...(input.error ? { error: input.error } : {}),
  };
}

function makeHarness(...results: ReturnType<typeof commandResult>[]) {
  const spawnSync = vi.fn().mockImplementation(() => results.shift() ?? commandResult({}));
  const canonicalize = vi.fn((value: string) => value);
  const powerShell = {
    cwd: String.raw`C:\Windows`,
    env: { SystemRoot: String.raw`C:\Windows`, WINDIR: String.raw`C:\Windows` },
    executablePath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
  };
  const run = (overrides: Partial<Parameters<typeof sweepWindowsCuaDriverProcesses>[0]> = {}) =>
    sweepWindowsCuaDriverProcesses({
      executablePath: String.raw`C:\Program Files\bigbud\cua-driver.exe`,
      deps: {
        platform: "win32",
        canonicalize,
        resolvePowerShell: () => powerShell,
        spawnSync: spawnSync as never,
      },
      ...overrides,
    });
  return { canonicalize, powerShell, run, spawnSync };
}

describe("Windows CUA exact-path process sweep", () => {
  it("uses case-insensitive normalized Windows path equality without name matching", () => {
    expect(
      windowsExecutablePathsEqual(
        String.raw`C:\Program Files\bigbud\bin\..\cua-driver.exe`,
        String.raw`c:\program files\BIGBUD\cua-driver.exe`,
      ),
    ).toBe(true);
    expect(
      windowsExecutablePathsEqual(
        String.raw`C:\other\cua-driver.exe`,
        String.raw`C:\Program Files\bigbud\cua-driver.exe`,
      ),
    ).toBe(false);
    expect(
      windowsExecutablePathsEqual(
        String.raw`\\?\C:\Program Files\bigbud\cua-driver.exe`,
        String.raw`c:\program files\BIGBUD\cua-driver.exe`,
      ),
    ).toBe(true);
    expect(
      windowsExecutablePathsEqual(
        String.raw`\\?\UNC\server\share\bigbud\cua-driver.exe`,
        String.raw`\\server\share\BIGBUD\cua-driver.exe`,
      ),
    ).toBe(true);
  });

  it("transports spaces and non-ASCII paths only through a controlled environment variable", () => {
    const executablePath = String.raw`C:\Program Files\大芽\cua driver.exe`;
    const harness = makeHarness();

    harness.run({ executablePath });

    const [command, args, options] = harness.spawnSync.mock.calls[0]!;
    expect(command).toBe(harness.powerShell.executablePath);
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    expect(args).toContain("-NoLogo");
    expect(args).not.toContain(executablePath);
    expect(options.env.BIGBUD_CUA_SWEEP_TARGET_PATH).toBe(executablePath);
    expect(options.env.PATH).toBeUndefined();
    expect(options.cwd).toBe(harness.powerShell.cwd);
    expect(options.windowsHide).toBe(true);
    expect(options.timeout).toBeGreaterThan(0);
    expect(WINDOWS_CUA_SWEEP_SCRIPT).not.toContain(executablePath);
  });

  it("completes after a helper pass reports no exact-path matches", () => {
    const harness = makeHarness();

    expect(() => harness.run()).not.toThrow();

    expect(harness.canonicalize).toHaveBeenCalledOnce();
    expect(harness.spawnSync).toHaveBeenCalledOnce();
  });

  it("reruns after terminating a match and requires a no-match verification pass", () => {
    const harness = makeHarness(
      commandResult({
        stdout: JSON.stringify({ status: "ok", matched: 1, terminated: 1, raced: 0 }),
      }),
      commandResult({}),
    );

    expect(() => harness.run()).not.toThrow();

    expect(harness.spawnSync).toHaveBeenCalledTimes(2);
  });

  it("re-enumerates after a candidate exits during handle acquisition", () => {
    const harness = makeHarness(
      commandResult({
        stdout: JSON.stringify({ status: "ok", matched: 0, terminated: 0, raced: 1 }),
      }),
      commandResult({}),
    );

    expect(() => harness.run()).not.toThrow();
    expect(harness.spawnSync).toHaveBeenCalledTimes(2);
  });

  it.each([
    "open_failed",
    "query_failed",
    "termination_failed",
    "wait_timeout",
    "wait_failed",
    "inspect_open_failed",
    "inspect_query_failed",
    "identity_candidate_open_failed",
    "identity_target_open_failed",
    "identity_candidate_query_failed",
    "identity_target_query_failed",
  ])("fails closed when the native helper reports %s", (code) => {
    const harness = makeHarness(
      commandResult({
        status: 1,
        stdout: JSON.stringify({ status: "error", code, pid: 73 }),
      }),
    );

    expect(() => harness.run()).toThrow(`Windows CUA process sweep failed (${code}) pid=73.`);
  });

  it("fails when matching processes remain after the bounded attempt count", () => {
    const match = () =>
      commandResult({
        stdout: JSON.stringify({ status: "ok", matched: 1, terminated: 1, raced: 0 }),
      });
    const harness = makeHarness(match(), match());

    expect(() => harness.run({ attempts: 2 })).toThrow(
      "could not confirm that all exact-path matches exited",
    );
    expect(harness.spawnSync).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["malformed output", commandResult({ stdout: "not-json" }), "malformed output"],
    [
      "unexpected fields",
      commandResult({
        stdout: JSON.stringify({
          status: "ok",
          matched: 0,
          terminated: 0,
          raced: 0,
          extra: true,
        }),
      }),
      "malformed output",
    ],
    ["unexpected stderr", commandResult({ stderr: "profile noise" }), "unexpected command result"],
    [
      "unexpected status",
      commandResult({
        status: 1,
        stdout: JSON.stringify({ status: "ok", matched: 0, terminated: 0, raced: 0 }),
      }),
      "unexpected_status",
    ],
  ] as const)("fails closed on %s", (_name, result, message) => {
    const harness = makeHarness(result);
    expect(() => harness.run()).toThrow(message);
  });

  it("reports a bounded command timeout without exposing command output", () => {
    const error = Object.assign(new Error("spawnSync powershell ETIMEDOUT secret"), {
      code: "ETIMEDOUT",
    });
    const harness = makeHarness(commandResult({ error, status: null }));

    expect(() => harness.run({ commandTimeoutMs: 25 })).toThrow(
      "Windows CUA process sweep exceeded its command timeout.",
    );
  });

  it("reports PowerShell spawn failure without leaking the underlying error", () => {
    const harness = makeHarness(
      commandResult({ error: new Error("private spawn details"), status: null }),
    );

    expect(() => harness.run()).toThrow("could not start PowerShell");
  });

  it("does nothing on non-Windows platforms", () => {
    const spawnSync = vi.fn();
    sweepWindowsCuaDriverProcesses({
      executablePath: null,
      deps: {
        platform: "darwin",
        canonicalize: vi.fn(),
        resolvePowerShell: vi.fn(),
        spawnSync: spawnSync as never,
      },
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("binds verification, termination, and waiting to one native process handle", () => {
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain("QueryFullProcessImageNameW(handle");
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain("TerminateProcess(handle");
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain("WaitForSingleObject(handle");
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain("CloseHandle(handle)");
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain("StringComparison.OrdinalIgnoreCase");
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain("GetFileInformationByHandle");
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain("if (leftHandle == new IntPtr(-1)) return -1");
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain("if (rightHandle == new IntPtr(-1)) return -2");
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain(
      "if (!GetFileInformationByHandle(leftHandle, out leftInfo)) return -3",
    );
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain(
      "if (!GetFileInformationByHandle(rightHandle, out rightInfo)) return -4",
    );
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain("return sameIdentity ? 1 : 0");
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain("return identity < 0 ? identity - 1 : identity");
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain(
      "OpenProcess(ProcessQueryLimitedInformation, false, processId)",
    );
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain(
      "ProcessTerminate | ProcessQueryLimitedInformation | Synchronize",
    );
    expect(
      WINDOWS_CUA_SWEEP_SCRIPT.indexOf("InspectCandidate(processId, expectedPath)"),
    ).toBeLessThan(
      WINDOWS_CUA_SWEEP_SCRIPT.lastIndexOf("VerifyTerminateAndWait(processId, expectedPath"),
    );
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain("ProcessIsGone(processId)");
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain("ErrorInvalidParameter");
    expect(WINDOWS_CUA_SWEEP_SCRIPT).toContain('Process.GetProcessesByName("cua-driver")');
    expect(WINDOWS_CUA_SWEEP_SCRIPT).not.toMatch(
      /Win32_Process|ExecutablePath|taskkill|Stop-Process/i,
    );
  });
});
