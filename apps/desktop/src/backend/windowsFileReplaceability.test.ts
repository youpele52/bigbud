import { describe, expect, it, vi } from "vitest";

import { assertWindowsFilesReplaceable } from "./windowsFileReplaceability";
import { WINDOWS_FILE_REPLACEABILITY_SCRIPT } from "./windowsFileReplaceability.script";

function result(input: {
  readonly error?: Error;
  readonly status?: number | null;
  readonly stderr?: string;
  readonly stdout?: string;
}) {
  return {
    ...(input.error ? { error: input.error } : {}),
    pid: 7,
    output: [],
    signal: null,
    status: input.status ?? 0,
    stderr: input.stderr ?? "",
    stdout: input.stdout ?? JSON.stringify({ status: "ok", checked: 1 }),
  };
}

function makeHarness(commandResult = result({})) {
  const spawnSync = vi.fn(() => commandResult);
  const powerShell = {
    cwd: String.raw`C:\Windows`,
    env: { SystemRoot: String.raw`C:\Windows`, WINDIR: String.raw`C:\Windows` },
    executablePath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
  };
  const targets = [{ label: "the packaged workspace agent", path: String.raw`C:\app\agent.exe` }];
  const run = () =>
    assertWindowsFilesReplaceable({
      targets,
      deps: {
        platform: "win32",
        resolvePowerShell: () => powerShell,
        spawnSync: spawnSync as never,
      },
    });
  return { powerShell, run, spawnSync, targets };
}

describe("assertWindowsFilesReplaceable", () => {
  it("uses trusted PowerShell, a minimal environment, and a bounded hidden invocation", () => {
    const harness = makeHarness();
    harness.run();

    const [command, args, options] = harness.spawnSync.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string>; timeout: number; windowsHide: boolean },
    ];
    expect(command).toBe(harness.powerShell.executablePath);
    expect(args).toContain("-NoProfile");
    expect(options.cwd).toBe(harness.powerShell.cwd);
    expect(options.env.PATH).toBeUndefined();
    expect(JSON.parse(options.env.BIGBUD_WINDOWS_REPLACEABILITY_PATHS!)).toEqual([
      harness.targets[0]!.path,
    ]);
    expect(options.timeout).toBe(60_000);
    expect(options.windowsHide).toBe(true);
  });

  it("fails closed with actionable guidance when a known child executable remains locked", () => {
    const harness = makeHarness(
      result({
        status: 1,
        stdout: JSON.stringify({
          status: "error",
          code: "file_not_replaceable",
          index: 0,
          win32Error: 32,
        }),
      }),
    );

    expect(harness.run).toThrow(
      "Windows could not prove the packaged workspace agent is replaceable (file_not_replaceable, win32=32)",
    );
    expect(harness.run).toThrow("Third-party and antivirus locks are detected");
  });

  it.each([
    ["malformed JSON", result({ stdout: "forged" }), "malformed output"],
    ["stderr", result({ stderr: "profile output" }), "unexpected command result"],
    [
      "timeout",
      result({ error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null }),
      "exceeded its command timeout",
    ],
  ] as const)("fails closed on %s", (_name, commandResult, message) => {
    expect(makeHarness(commandResult).run).toThrow(message);
  });

  it("requests replacement access without changing or deleting the target", () => {
    expect(WINDOWS_FILE_REPLACEABILITY_SCRIPT).toContain(
      "GenericRead | GenericWrite | DeleteAccess",
    );
    expect(WINDOWS_FILE_REPLACEABILITY_SCRIPT).toContain(
      "FileShareRead | FileShareWrite | FileShareDelete",
    );
    expect(WINDOWS_FILE_REPLACEABILITY_SCRIPT).not.toMatch(
      /DeleteFile|MoveFile|SetFileInformationByHandle/,
    );
  });
});
