import { describe, expect, it } from "vitest";
import type {
  ShellHostScope,
  TerminalShellProfile,
} from "@bigbud/contracts/workspace/terminalShell.ts";
import { LOCAL_SHELL_HOST, shellProfileId } from "./ShellProfiles.identity";
import { resolveShellProfileLaunch, sameShellHost } from "./ShellProfiles.launch";

function profile(overrides: Partial<TerminalShellProfile> = {}): TerminalShellProfile {
  const value: TerminalShellProfile = {
    profileId: "pending",
    host: LOCAL_SHELL_HOST,
    kind: "pwsh",
    displayName: "PowerShell 7",
    executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    args: ["-NoLogo"],
    platform: "win32",
    availability: "available",
    integration: { status: "unavailable", reason: "not-qualified" },
    ...overrides,
  };
  return {
    ...value,
    profileId: shellProfileId(value.host, value.executable, value.args, value.platform),
  };
}

function resolve(selected: TerminalShellProfile, profiles = [selected], host = selected.host) {
  return resolveShellProfileLaunch({
    host,
    selection: { kind: "profile", profileId: selected.profileId },
    profiles,
  });
}

describe("shell profile launch resolution", () => {
  it("leaves legacy fallback entirely to the existing launch policy", () => {
    expect(
      resolveShellProfileLaunch({
        host: LOCAL_SHELL_HOST,
        selection: { kind: "legacy-auto" },
        profiles: [],
      }),
    ).toBeNull();
  });

  it("keeps a spaced executable and argv separate with consistent resolved identity", () => {
    const selected = profile();
    const launch = resolve(selected);
    expect(launch).toMatchObject({
      shell: selected.executable,
      args: ["-NoLogo"],
      platform: "win32",
      dropPathMode: "powershell",
      identity: {
        profileId: selected.profileId,
        selection: { kind: "profile", profileId: selected.profileId },
      },
    });
    expect(launch?.args).not.toBe(selected.args);
  });

  it("fails missing or unavailable explicit profiles even when alternatives exist", () => {
    const selected = profile();
    expect(() =>
      resolve(selected, [profile({ kind: "cmd", executable: "C:\\Windows\\System32\\cmd.exe" })]),
    ).toThrow();
    expect(() => resolve({ ...selected, availability: "unavailable" })).toThrow();
  });

  it("rejects stale executable/argv identities and ambiguous inventories", () => {
    const selected = profile();
    expect(() => resolve(selected, [{ ...selected, args: ["-Command", "unexpected"] }])).toThrow();
    expect(() => resolve(selected, [{ ...selected, executable: "C:\\different.exe" }])).toThrow();
    expect(() => resolve(selected, [selected, selected])).toThrow();
    expect(() => resolve(profile({ executable: "pwsh.exe" }))).toThrow();
  });

  it("does not substitute a local inventory for another execution host", () => {
    const selected = profile();
    expect(() => resolve(selected, [selected], { kind: "ssh", hostId: "remote" })).toThrow();
  });

  it("pins WSL distribution and username even when opaque host IDs match", () => {
    const host: ShellHostScope = {
      kind: "wsl",
      hostId: "wsl-1",
      distribution: "Ubuntu",
      username: "one",
    };
    expect(sameShellHost(host, { ...host, username: "two" })).toBe(false);
    expect(sameShellHost(host, { ...host, distribution: "Debian" })).toBe(false);
    expect(sameShellHost(host, { ...host })).toBe(true);
  });

  it("uses PowerShell quoting on Unix too, preserving paths such as /tmp/O'Brien.txt", () => {
    expect(resolve(profile({ executable: "/usr/bin/pwsh", platform: "linux" }))?.dropPathMode).toBe(
      "powershell",
    );
    expect(
      resolve(profile({ kind: "cmd", executable: "C:\\Windows\\System32\\cmd.exe" }))?.dropPathMode,
    ).toBe("cmd");
  });
});
