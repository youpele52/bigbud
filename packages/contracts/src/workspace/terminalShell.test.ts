import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  ShellHostScope,
  ShellLaunchIdentity,
  ShellLaunchIntent,
  ShellSelection,
  ShellUnconfirmedLaunch,
  TerminalShellProfile,
} from "./terminalShell";

const profile = {
  profileId: "local:pwsh:stable",
  host: { kind: "local", hostId: "local" },
  kind: "pwsh",
  displayName: "PowerShell",
  executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  args: ["-NoLogo"],
  platform: "win32",
  availability: "available",
  integration: { status: "unavailable", reason: "not-qualified" },
} as const;

describe("execution-host terminal shell contracts", () => {
  it("preserves executable paths and fixed arguments separately", () => {
    expect(Schema.decodeUnknownSync(TerminalShellProfile)(profile)).toEqual(profile);
    expect(
      Schema.decodeUnknownSync(TerminalShellProfile)({
        ...profile,
        executable: "/opt/工具 and shells/zsh",
        args: ["-l", ""],
        platform: "linux",
        kind: "zsh",
      }).executable,
    ).toBe("/opt/工具 and shells/zsh");
  });

  it.each(["\0", "\r", "\n", "\u001b", "\u0085", "\u2028", "\u2029"])(
    "rejects executable/label control character %j",
    (control) => {
      for (const field of ["executable", "displayName"]) {
        expect(Schema.is(TerminalShellProfile)({ ...profile, [field]: `shell${control}` })).toBe(
          false,
        );
      }
    },
  );

  it("bounds inventories' individual fields and launch arguments", () => {
    expect(Schema.is(TerminalShellProfile)({ ...profile, args: Array(33).fill("-l") })).toBe(false);
    expect(Schema.is(TerminalShellProfile)({ ...profile, args: ["x".repeat(4097)] })).toBe(false);
    expect(Schema.is(TerminalShellProfile)({ ...profile, args: ["-l\ncommand"] })).toBe(false);
    expect(Schema.is(TerminalShellProfile)({ ...profile, executable: "x".repeat(4097) })).toBe(
      false,
    );
    expect(
      Schema.is(TerminalShellProfile)({ ...profile, profileId: "https://host/password" }),
    ).toBe(false);
  });

  it("requires pinned WSL guest identity and opaque host IDs", () => {
    expect(Schema.is(ShellHostScope)({ kind: "wsl", hostId: "wsl:ubuntu" })).toBe(false);
    expect(
      Schema.decodeUnknownSync(ShellHostScope)({
        kind: "wsl",
        hostId: "wsl:ubuntu:user",
        distribution: "Ubuntu",
        username: "user",
      }),
    ).toEqual({
      kind: "wsl",
      hostId: "wsl:ubuntu:user",
      distribution: "Ubuntu",
      username: "user",
    });
    expect(Schema.is(ShellHostScope)({ kind: "ssh", hostId: "user@host" })).toBe(false);
  });

  it("does not accept executable command strings as a selection", () => {
    expect(Schema.decodeUnknownSync(ShellSelection)({ kind: "legacy-auto" })).toEqual({
      kind: "legacy-auto",
    });
    expect(Schema.is(ShellSelection)({ kind: "profile", executable: "/bin/zsh" })).toBe(false);
    expect(Schema.is(ShellSelection)({ kind: "profile", profileId: "/bin/zsh -c command" })).toBe(
      false,
    );
  });

  it("keeps requested profiles distinct from confirmed identity and integration readiness", () => {
    const requestedProfile = {
      host: profile.host,
      profileId: profile.profileId,
      kind: profile.kind,
    };
    const pending = { status: "unconfirmed", requestedProfile };
    expect(Schema.decodeUnknownSync(ShellUnconfirmedLaunch)(pending)).toEqual(pending);
    expect(Schema.is(ShellLaunchIdentity)(requestedProfile)).toBe(false);
    expect(Schema.is(ShellLaunchIntent)({ ...requestedProfile, profileId: "bad\nvalue" })).toBe(
      false,
    );
    expect(Schema.is(ShellUnconfirmedLaunch)({ ...pending, status: "confirmed" })).toBe(false);
    expect(Schema.is(ShellUnconfirmedLaunch)({ status: "unconfirmed" })).toBe(false);
  });

  it("represents unknown legacy identity without inventing a discovered profile", () => {
    expect(
      Schema.decodeUnknownSync(ShellLaunchIdentity)({
        host: profile.host,
        selection: { kind: "legacy-auto" },
        profileId: null,
        kind: "other",
        integration: { status: "unknown" },
      }).profileId,
    ).toBeNull();
  });
});
