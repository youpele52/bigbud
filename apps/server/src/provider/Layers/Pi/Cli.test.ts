import { describe, expect, it } from "vitest";

import { quoteWindowsPiShellCommand, shouldUseWindowsPiShell, resolvePiInvocation } from "./Cli.ts";

async function withMockedPlatform<T>(platform: NodeJS.Platform, run: () => T): Promise<T> {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  }
}

describe("Pi CLI Windows invocation helpers", () => {
  it("resolves the installed ESM-only bundled CLI without falling back to PATH", () => {
    const invocation = resolvePiInvocation("pi");
    expect(invocation.bundledCliPath?.replaceAll("\\", "/")).toMatch(/\/dist\/bundle\/cli\.js$/);
    expect(resolvePiInvocation("/custom/pi")).toEqual({ command: "/custom/pi", args: [] });
  });
  it("uses a shell for Windows npm command shims", async () => {
    await withMockedPlatform("win32", () => {
      expect(shouldUseWindowsPiShell("pi")).toBe(true);
      expect(shouldUseWindowsPiShell("C:\\Users\\Youpele PC\\AppData\\Roaming\\npm\\pi.cmd")).toBe(
        true,
      );
      expect(shouldUseWindowsPiShell("C:\\Tools\\pi.exe")).toBe(false);
    });
  });

  it("quotes Windows shell commands with spaces", async () => {
    await withMockedPlatform("win32", () => {
      expect(quoteWindowsPiShellCommand("C:\\Users\\Youpele PC\\npm\\pi.cmd")).toBe(
        '"C:\\Users\\Youpele PC\\npm\\pi.cmd"',
      );
      expect(quoteWindowsPiShellCommand('"C:\\Users\\Youpele PC\\npm\\pi.cmd"')).toBe(
        '"C:\\Users\\Youpele PC\\npm\\pi.cmd"',
      );
      expect(quoteWindowsPiShellCommand("C:\\Tools\\pi.cmd")).toBe("C:\\Tools\\pi.cmd");
    });
  });

  it("does not apply Windows shell behavior on other platforms", async () => {
    await withMockedPlatform("darwin", () => {
      expect(shouldUseWindowsPiShell("pi")).toBe(false);
      expect(quoteWindowsPiShellCommand("/Users/Youpele PC/npm/pi.cmd")).toBe(
        "/Users/Youpele PC/npm/pi.cmd",
      );
    });
  });
});
