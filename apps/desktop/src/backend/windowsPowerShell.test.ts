import * as Path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveTrustedWindowsPowerShell } from "./windowsPowerShell";

describe("resolveTrustedWindowsPowerShell", () => {
  it("uses the absolute stock Windows PowerShell path without inheriting PATH or cwd", () => {
    const maliciousDirectory = String.raw`C:\attacker`;
    const maliciousPowerShell = Path.win32.join(maliciousDirectory, "powershell.exe");
    const existsSync = vi.fn((path: string) => path !== maliciousPowerShell);

    const resolved = resolveTrustedWindowsPowerShell({
      env: {
        SystemRoot: String.raw`C:\Windows`,
        WINDIR: String.raw`c:\windows`,
        PATH: maliciousDirectory,
        TEMP: String.raw`C:\Temp`,
      },
      existsSync,
    });

    expect(resolved.executablePath).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(resolved.executablePath).not.toBe(maliciousPowerShell);
    expect(resolved.cwd).toBe(String.raw`C:\Windows`);
    expect(resolved.env).toEqual({
      SystemRoot: String.raw`C:\Windows`,
      WINDIR: String.raw`C:\Windows`,
      TEMP: String.raw`C:\Temp`,
    });
    expect(resolved.env.PATH).toBeUndefined();
  });

  it("fails closed when Windows roots are absent, relative, or inconsistent", () => {
    const existsSync = vi.fn(() => true);
    expect(() => resolveTrustedWindowsPowerShell({ env: {}, existsSync })).toThrow(
      "could not establish the trusted Windows directory",
    );
    expect(() =>
      resolveTrustedWindowsPowerShell({
        env: { SystemRoot: "Windows", WINDIR: "Windows" },
        existsSync,
      }),
    ).toThrow("could not establish the trusted Windows directory");
    expect(() =>
      resolveTrustedWindowsPowerShell({
        env: { SystemRoot: String.raw`C:\Windows`, WINDIR: String.raw`D:\Windows` },
        existsSync,
      }),
    ).toThrow("could not establish the trusted Windows directory");
  });

  it("fails closed when stock Windows PowerShell 5.1 is missing", () => {
    expect(() =>
      resolveTrustedWindowsPowerShell({
        env: { SystemRoot: String.raw`C:\Windows`, WINDIR: String.raw`C:\Windows` },
        existsSync: () => false,
      }),
    ).toThrow("could not find trusted Windows PowerShell 5.1");
  });
});
