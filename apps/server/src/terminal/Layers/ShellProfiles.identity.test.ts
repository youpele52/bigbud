import { describe, expect, it } from "vitest";
import type { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import {
  LOCAL_SHELL_HOST,
  preferredFreshWindowsShell,
  shellExecutableIdentity,
  shellKind,
  shellProfileId,
} from "./ShellProfiles.identity";

const profile = (
  kind: TerminalShellProfile["kind"],
  overrides: Partial<TerminalShellProfile> = {},
): TerminalShellProfile => ({
  profileId: `shell:${kind}`,
  host: LOCAL_SHELL_HOST,
  kind,
  displayName: kind,
  executable: `C:\\Shells\\${kind}.exe`,
  args: [],
  platform: "win32",
  availability: "available",
  integration: { status: "unavailable", reason: "not-qualified" },
  ...overrides,
});

describe("shell profile identity", () => {
  it("normalizes Windows path spelling without rewriting Unix case", () => {
    expect(shellExecutableIdentity("C:\\Shells\\..\\PowerShell\\PWSH.EXE", "win32")).toBe(
      "c:/powershell/pwsh.exe",
    );
    expect(shellExecutableIdentity("/Applications/Shell", "darwin")).toBe("/Applications/Shell");
    expect(shellProfileId(LOCAL_SHELL_HOST, "C:\\Shells\\pwsh.exe", [], "win32")).toBe(
      shellProfileId(LOCAL_SHELL_HOST, "c:/shells/PWSH.EXE", [], "win32"),
    );
  });

  it("binds identity to host and fixed argv without whitespace splitting", () => {
    const local = shellProfileId(LOCAL_SHELL_HOST, "/bin/zsh", ["a b"], "linux");
    expect(local).toMatch(/^shell:v1:[a-f0-9]{64}$/);
    expect(local).not.toBe(shellProfileId(LOCAL_SHELL_HOST, "/bin/zsh", ["a", "b"], "linux"));
    expect(local).not.toBe(
      shellProfileId({ kind: "ssh", hostId: "remote-1" }, "/bin/zsh", ["a b"], "linux"),
    );
    const wsl = { kind: "wsl", hostId: "wsl-1", distribution: "Ubuntu", username: "one" } as const;
    expect(shellProfileId(wsl, "/bin/bash", [], "linux")).not.toBe(
      shellProfileId({ ...wsl, username: "two" }, "/bin/bash", [], "linux"),
    );
    expect(shellProfileId(wsl, "/bin/bash", [], "linux")).not.toBe(
      shellProfileId({ ...wsl, distribution: "Debian" }, "/bin/bash", [], "linux"),
    );
  });

  it("classifies executable basenames rather than command strings", () => {
    expect(shellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32")).toBe("pwsh");
    expect(shellKind("C:\\Windows\\powershell.EXE", "win32")).toBe("windows-powershell");
    expect(shellKind("/bin/bash", "linux")).toBe("bash");
    expect(shellKind("/bin/bash -l", "linux")).toBe("other");
  });
});

describe("fresh Windows profile preference", () => {
  it("prefers installed PS7, then Windows PowerShell, then cmd", () => {
    const cmd = profile("cmd");
    const ps = profile("windows-powershell");
    const pwsh = profile("pwsh");
    expect(preferredFreshWindowsShell([cmd, ps, pwsh])).toBe(pwsh);
    expect(preferredFreshWindowsShell([cmd, ps])).toBe(ps);
    expect(preferredFreshWindowsShell([cmd])).toBe(cmd);
  });

  it("excludes unavailable, remote, noncanonical local, and non-Windows profiles", () => {
    expect(
      preferredFreshWindowsShell([
        profile("pwsh", { availability: "unavailable" }),
        profile("pwsh", { host: { kind: "ssh", hostId: "remote" } }),
        profile("pwsh", { host: { kind: "local", hostId: "elsewhere" } }),
        profile("pwsh", { platform: "linux" }),
      ]),
    ).toBeUndefined();
  });

  it("breaks same-kind ties deterministically without mutating inventory", () => {
    const inventory = [profile("pwsh", { profileId: "b" }), profile("pwsh", { profileId: "a" })];
    expect(preferredFreshWindowsShell(inventory)?.profileId).toBe("a");
    expect(inventory.map((item) => item.profileId)).toEqual(["b", "a"]);
  });
});
