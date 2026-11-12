import type { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import { describe, expect, it } from "vitest";
import { shellProfileId } from "./ShellProfiles.identity";
import { resolveShellProfileLaunch } from "./ShellProfiles.launch";
import { remoteShellHost, type RemoteShellDiscoveryInput } from "./ShellProfiles.remote.identity";
import { directShellProfileInvocation } from "./ShellProfiles.remote.launch";

const ssh = { executionTargetId: "ssh:host=example.test&user=tester&transport=direct-ssh" };
const wsl = {
  executionTargetId: "wsl:Ubuntu",
  wslIdentity: { distribution: "Ubuntu", username: "tester", uid: 1000 },
};
function resolved(input: RemoteShellDiscoveryInput = ssh) {
  const host = remoteShellHost(input);
  const executable = "/usr/bin/zsh";
  const args = ["-o", "nopromptsp"];
  const profile: TerminalShellProfile = {
    host,
    executable,
    args,
    platform: "linux",
    kind: "zsh",
    displayName: "zsh",
    profileId: shellProfileId(host, executable, args, "linux"),
    availability: "available",
    integration: { status: "disabled" },
  };
  return resolveShellProfileLaunch({
    host,
    selection: { kind: "profile", profileId: profile.profileId },
    profiles: [profile],
  })!;
}
const cwd = "/home/tester/project with 'quotes'";

describe("exact direct execution-host profile invocation planning", () => {
  it("uses a nonlogin SSH wrapper, final account/cwd checks and exact executable/argv", () => {
    const result = directShellProfileInvocation({ ...ssh, cwd, launch: resolved() });
    expect(result.transport).toBe("ssh");
    expect(result.invocation.command).toBe("ssh");
    expect(result.invocation.args).toContain("-tt");
    expect(result.invocation.args).toContain("BatchMode=yes");
    const command = result.invocation.args.at(-1)!;
    expect(command).toMatch(/^'\/bin\/sh' '-c' /);
    expect(command).toContain("/usr/bin/id -un");
    expect(command).toContain('cd "$1"');
    expect(command).toContain('exec "$@"');
    expect(command).toContain("'/usr/bin/zsh' '-o' 'nopromptsp'");
    expect(command).not.toContain("'-lc'");
    expect(command).not.toContain("${SHELL");
    expect(result.launch.cwd).toBe(cwd);
    expect(result).not.toHaveProperty("shellLaunchIdentity");
    expect(result).not.toHaveProperty("launchStatus");
  });

  it("pins WSL distro/user/UID and rechecks cwd without invoking a desktop shell", () => {
    const result = directShellProfileInvocation({ ...wsl, cwd, launch: resolved(wsl) });
    expect(result.transport).toBe("wsl");
    expect(result.invocation.command).toMatch(/System32[\\/]wsl\.exe$/);
    expect(result.invocation.args.slice(0, 5)).toEqual([
      "--distribution",
      "Ubuntu",
      "--user",
      "tester",
      "--exec",
    ]);
    expect(result.invocation.args.at(-8)).toContain("/usr/bin/id -u");
    expect(result.invocation.args.slice(-7)).toEqual([
      "sh",
      "tester",
      "1000",
      cwd,
      "/usr/bin/zsh",
      "-o",
      "nopromptsp",
    ]);
    expect(result.invocation.args).not.toContain("-lc");
    expect(result.invocation.args).not.toContain("cmd.exe");
    expect(result.wslIdentity).toEqual(wsl.wslIdentity);
    expect(result.wslIdentity).not.toBe(wsl.wslIdentity);
  });

  it.each([ssh, wsl])("forwards only terminal/locale overrides to $executionTargetId", (input) => {
    const result = directShellProfileInvocation({
      ...input,
      cwd,
      launch: resolved(input),
      runtimeEnv: {
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        LC_TIME: "C",
        HOME: "/desktop",
        PATH: "/workspace/bin",
        SHELL: "/desktop/shell",
        SECRET: "do-not-forward",
        LC_bad: "invalid-locale-name",
      },
    });
    const text = JSON.stringify(result.invocation);
    for (const value of ["TERM=xterm-256color", "LANG=en_US.UTF-8", "LC_TIME=C"]) {
      expect(text).toContain(value);
    }
    for (const value of ["/desktop", "/workspace/bin", "do-not-forward", "invalid-locale-name"]) {
      expect(text).not.toContain(value);
    }
  });

  it("rejects stale/mutated selection, host and executable plans without a fallback", () => {
    const launch = resolved();
    for (const changed of [
      { ...launch, args: [] },
      { ...launch, shell: "/bin/bash" },
      { ...launch, identity: { ...launch.identity, selection: { kind: "legacy-auto" as const } } },
    ])
      expect(() => directShellProfileInvocation({ ...ssh, cwd, launch: changed })).toThrow();
    expect(() => directShellProfileInvocation({ ...wsl, cwd, launch })).toThrow();
    expect(() =>
      directShellProfileInvocation({
        executionTargetId: ssh.executionTargetId.replace("direct-ssh", "agent"),
        cwd,
        launch,
      }),
    ).toThrow(/agent execution target/);
    expect(() =>
      directShellProfileInvocation({
        ...wsl,
        wslIdentity: { ...wsl.wslIdentity, username: "other" },
        cwd,
        launch: resolved(wsl),
      }),
    ).toThrow();
  });

  it.each(["relative", "/bad\npath", "/bad\0path"])("rejects invalid cwd %j", (path) => {
    expect(() => directShellProfileInvocation({ ...ssh, cwd: path, launch: resolved() })).toThrow();
  });

  it("keeps generation-scoped PID evidence separate from immutable requested identity", () => {
    const generation = "11111111-2222-4333-8444-555555555555";
    const legacy = directShellProfileInvocation({ ...ssh, cwd, launch: resolved() });
    const marked = directShellProfileInvocation({
      ...ssh,
      cwd,
      launch: resolved(),
      runtimeGeneration: generation,
    });
    expect(marked.launch).toEqual(legacy.launch);
    expect(marked.invocation.args.at(-1)).toContain(`bigbud-shell-${generation}`);
    expect(marked.invocation.args.at(-1)).toContain("printf");
    expect(marked).not.toHaveProperty("shellLaunchIdentity");
    expect(() =>
      directShellProfileInvocation({
        ...ssh,
        cwd,
        launch: resolved(),
        runtimeGeneration: "unsafe;command",
      }),
    ).toThrow(/generation/);
  });

  it("copies the launch arguments before handing the plan to an owner", () => {
    const launch = resolved();
    const result = directShellProfileInvocation({ ...ssh, cwd, launch });
    (launch.args as string[]).push("unexpected");
    expect(result.launch.args).toEqual(["-o", "nopromptsp"]);
    expect(result.invocation.args.at(-1)).not.toContain("unexpected");
  });
});
