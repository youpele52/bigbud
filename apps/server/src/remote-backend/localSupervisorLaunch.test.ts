import { describe, expect, it } from "vitest";
import type { PtySpawnInput } from "../terminal/Services/PTY.ts";
import { LOCAL_SHELL_HOST, shellProfileId } from "../terminal/Layers/ShellProfiles.identity.ts";
import { localSupervisorTarget, localSupervisorShellHost } from "./localSupervisorIdentity.ts";
import { localSupervisorLaunch } from "./localSupervisorLaunch.ts";

const target = localSupervisorTarget("a".repeat(32));
const input = (): PtySpawnInput => ({
  shell: "/bin/bash",
  args: ["--noprofile", "--norc"],
  cwd: "/workspace",
  cols: 80,
  rows: 24,
  env: { PATH: "/bin:/usr/bin", TERM: "xterm-256color" },
  ownerKey: "fixture",
});

describe("authority-scoped local supervisor shell intent", () => {
  it("preserves exact candidate executable/argv/cwd and uses a distinct backend authority host", () => {
    const first = input();
    const launch = localSupervisorLaunch(first, target);
    expect(launch).toMatchObject({
      executable: first.shell,
      args: first.args,
      cwd: first.cwd,
      platform: "linux",
      integration: "disabled",
    });
    expect(launch.requestedProfile.host).toEqual({ kind: "agent", hostId: target });
    expect(launch.requestedProfile.profileId).not.toBe(
      localSupervisorLaunch(first, localSupervisorTarget("b".repeat(32))).requestedProfile
        .profileId,
    );
    first.args!.push("changed-after-prepare");
    expect(launch.args).toEqual(["--noprofile", "--norc"]);
  });

  it("checks a selected local profile before translating its host scope", () => {
    const first = input();
    const profileId = shellProfileId(LOCAL_SHELL_HOST, first.shell, first.args!, "linux");
    const selected = {
      ...first,
      shellProfile: {
        host: LOCAL_SHELL_HOST,
        selection: { kind: "profile" as const, profileId },
        profileId,
        kind: "bash" as const,
        integration: { status: "disabled" as const },
      },
    };
    expect(localSupervisorLaunch(selected, target).requestedProfile.host).toEqual(
      localSupervisorShellHost(target),
    );
    expect(() => localSupervisorLaunch({ ...selected, args: ["--different"] }, target)).toThrow(
      "does not match",
    );
    expect(() =>
      localSupervisorLaunch(
        {
          ...selected,
          shellProfile: { ...selected.shellProfile, host: { kind: "agent", hostId: "other" } },
        },
        target,
      ),
    ).toThrow("does not match");
  });

  it("resolves bare server candidates on the execution host and refuses missing commands", () => {
    expect(localSupervisorLaunch({ ...input(), shell: "sh" }, target).executable).toMatch(/\/sh$/);
    expect(() =>
      localSupervisorLaunch({ ...input(), shell: "missing-bigbud-fixture-shell" }, target),
    ).toThrow("unavailable");
  });

  it("rejects aliases, malformed authority IDs and invalid execution paths", () => {
    for (const wrong of ["local", "ssh:alias", "remote-backend:bad"])
      expect(() => localSupervisorShellHost(wrong)).toThrow();
    expect(() => localSupervisorTarget("not-an-authority")).toThrow();
    expect(() => localSupervisorLaunch({ ...input(), cwd: "relative" }, target)).toThrow(
      "absolute",
    );
    expect(() => localSupervisorLaunch({ ...input(), args: ["bad\nargument"] }, target)).toThrow();
  });
});
