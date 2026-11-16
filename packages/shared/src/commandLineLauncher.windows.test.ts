import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installCommandLineLauncher,
  resolveCommandLineLauncherTarget,
} from "./commandLineLauncher.ts";
import {
  BIGBUD_WINDOWS_LAUNCHER_MARKER,
  buildWindowsCommandLineLauncher,
} from "./commandLineLauncher.windows.ts";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawn }));
beforeEach(() => {
  spawn.mockReset();
  spawn.mockReturnValue({ status: 0, stdout: "installed\n" });
});
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) FS.rmSync(directory, { recursive: true });
});
function fixture() {
  const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "bb-winlauncher-"));
  directories.push(home);
  const runtime = Path.join(home, "runtime %!&.exe");
  const script = Path.join(home, "bin.mjs");
  const shim = Path.join(home, "native-shim.exe");
  FS.writeFileSync(runtime, "runtime");
  FS.writeFileSync(script, "entry");
  FS.writeFileSync(shim, "MZ-fixture");
  return {
    home,
    shim,
    binDir: Path.join(home, ".local", "bin"),
    base: {
      platform: "win32" as const,
      homeDir: home,
      pathValue: "",
      target: {
        kind: "direct" as const,
        nodeExecutable: runtime,
        serverEntry: script,
        windowsShim: shim,
      },
    },
  };
}
describe("Windows native command-line launcher", () => {
  it("writes literal paths without cmd expansion and rejects descriptor injection", () => {
    expect(
      buildWindowsCommandLineLauncher({
        runtime: "C:\\100% !&\\bigbud.exe",
        script: "C:\\entry.mjs",
      }),
    ).toBe("bigbud-cli-launcher-v1\nC:\\100% !&\\bigbud.exe\nC:\\entry.mjs\n");
    for (const runtime of ["a\nb", "a\rb", "a\0b", "x".repeat(32768)])
      expect(buildWindowsCommandLineLauncher({ runtime, script: "entry" })).toBeNull();
  });
  it("calls the packaged installer with literal argv, no shell, and a deadline", () => {
    const { binDir, base, shim } = fixture();
    expect(installCommandLineLauncher(base)).toMatchObject({
      status: "installed",
      launcherPath: Path.join(binDir, "bigbud.exe"),
    });
    expect(spawn).toHaveBeenCalledWith(
      shim,
      [
        "--bigbud-cli-install-v1",
        Path.join(binDir, "bigbud.exe"),
        base.target.nodeExecutable,
        base.target.serverEntry,
      ],
      expect.objectContaining({ shell: false, timeout: 15000 }),
    );
    spawn.mockReturnValue({ status: 1, stdout: "" });
    expect(installCommandLineLauncher(base).status).toBe("unsupported");
  });
  it("surfaces recovery-budget inspection without exposing native error paths", () => {
    const { base } = fixture();
    spawn.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "BIGBUD_CLI_RECOVERY_LIMIT: private path",
    });
    expect(installCommandLineLauncher(base)).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("need inspection"),
    });
    expect(installCommandLineLauncher(base)).not.toHaveProperty(
      "reason",
      expect.stringContaining("private path"),
    );
  });
  it("migrates only a marked legacy cmd and preserves unrelated sidecars", () => {
    const { binDir, base } = fixture();
    FS.mkdirSync(binDir, { recursive: true });
    const legacy = Path.join(binDir, "bigbud.cmd");
    FS.writeFileSync(legacy, `@echo off\r\n${BIGBUD_WINDOWS_LAUNCHER_MARKER}\r\n`);
    expect(installCommandLineLauncher({ ...base, pathValue: binDir }).status).toBe("installed");
    expect(FS.existsSync(legacy)).toBe(false);
    const second = fixture();
    FS.mkdirSync(second.binDir, { recursive: true });
    FS.writeFileSync(Path.join(second.binDir, "bigbud.launch"), "foreign");
    spawn.mockReturnValue({ status: 1, stdout: "" });
    expect(installCommandLineLauncher(second.base).status).toBe("unsupported");
  });
  it("fails closed on missing shim and does not bypass foreign PATH commands", () => {
    const { base, binDir } = fixture();
    expect(
      installCommandLineLauncher({ ...base, target: { ...base.target, windowsShim: "" } }).status,
    ).toBe("unsupported");
    FS.mkdirSync(binDir, { recursive: true });
    FS.writeFileSync(Path.join(binDir, "bigbud.com"), "foreign");
    expect(installCommandLineLauncher({ ...base, pathValue: binDir }).status).toBe(
      "existing-command",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
  it("resolves the bundled native shim while Windows remains separately gated", () => {
    const target = resolveCommandLineLauncherTarget({
      platform: "win32",
      runtime: "/app/bigbud.exe",
      serverEntry: "/app/resources/server/dist/bin.mjs",
      environment: {},
    });
    expect(target).toMatchObject({
      windowsShim: "/app/resources/server/cli-launcher/bin/bigbud-cli-launcher.exe",
    });
    const { base } = fixture();
    expect(
      installCommandLineLauncher({
        ...base,
        target: { kind: "appimage", appImagePath: "/a", serverEntryInAppDir: "x" },
      }).status,
    ).toBe("unsupported");
  });
});
