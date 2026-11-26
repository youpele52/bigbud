import { describe, expect, it } from "vitest";

import { LOCAL_SHELL_HOST, shellProfileId } from "../terminal/Layers/ShellProfiles.identity.ts";
import type { PtySpawnInput } from "../terminal/Services/PTY.ts";
import {
  LOCAL_LAUNCH_MAX_ENTRIES,
  LOCAL_TERMINAL_HOST_LIFECYCLE,
  LocalTerminalHostLaunchSpecError,
  localTerminalHostLaunchEnvironment,
  localTerminalHostLaunchSpec,
  localTerminalHostPlatform,
  localTerminalHostShellAllowed,
  localTerminalHostShellLaunch,
  planLocalTerminalHostLaunch,
} from "./localTerminalHost.launchSpec.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";

const input = (overrides: Partial<PtySpawnInput> = {}): PtySpawnInput => ({
  shell: "/bin/zsh",
  args: ["-o", "nopromptsp"],
  cwd: "/work",
  cols: 80,
  rows: 24,
  env: {},
  ...overrides,
});

const integrationEnv = (dir: string) => ({
  BIGBUD_SHELL_INTEGRATION_DIR: dir,
  ZDOTDIR: `${dir}/zsh`,
  BIGBUD_FISH_DATA_DIR: `${dir}/fish`,
  BIGBUD_CLAUDE_HOOKS: `${dir}/claude-hooks.json`,
  BIGBUD_TERMINAL_AGENT_HOOKS: "1",
});

const realpath = (path: string) => (path === "/bin" ? "/usr/bin" : path);

const many = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`var_${index}`, "v"]));

describe("local terminal host launch spec", () => {
  it("uses the real platform and refuses platforms the host does not run on", () => {
    expect(localTerminalHostPlatform("darwin")).toBe("darwin");
    expect(localTerminalHostPlatform("linux")).toBe("linux");
    expect(() => localTerminalHostPlatform("win32")).toThrow(LocalTerminalHostLaunchSpecError);
    const launch = localTerminalHostShellLaunch(input(), "darwin");
    expect(launch).toMatchObject({
      platform: "darwin",
      executable: "/bin/zsh",
      args: ["-o", "nopromptsp"],
      cwd: "/work",
      // The host never injects an integration; the pane integration travels in the environment.
      integration: "disabled",
      requestedProfile: { host: { kind: "agent", hostId: LOCAL_TERMINAL_HOST_TARGET_ID } },
    });
  });

  it("accepts a matching local profile and rejects a mismatched one", () => {
    const args = ["-o", "nopromptsp"];
    const profile = (profileId: string) =>
      input({
        shellProfile: {
          host: LOCAL_SHELL_HOST,
          selection: { kind: "profile", profileId },
          profileId,
          kind: "zsh",
        } as NonNullable<PtySpawnInput["shellProfile"]>,
      });
    const matching = shellProfileId(LOCAL_SHELL_HOST, "/bin/zsh", args, "darwin");
    expect(localTerminalHostShellLaunch(profile(matching), "darwin").executable).toBe("/bin/zsh");
    expect(() => localTerminalHostShellLaunch(profile("other"), "darwin")).toThrow(
      "does not match",
    );
  });

  it("passes the full environment unchanged, lowercase names and PATH included", () => {
    const env = {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      SHELL: "/bin/zsh",
      http_proxy: "http://proxy.local:3128",
      no_proxy: "localhost",
      _: "/usr/bin/env",
      UNSET: undefined,
    };
    expect(localTerminalHostLaunchEnvironment(env)).toEqual([
      { name: "PATH", value: env.PATH },
      { name: "SHELL", value: env.SHELL },
      { name: "http_proxy", value: env.http_proxy },
      { name: "no_proxy", value: env.no_proxy },
      { name: "_", value: env._ },
    ]);
  });

  it("names the requested cwd in PWD, as node-pty does", () => {
    expect(localTerminalHostLaunchEnvironment({ PWD: "/stale", A: "1" }, "/tmp/work")).toEqual([
      { name: "PWD", value: "/tmp/work" },
      { name: "A", value: "1" },
    ]);
    const spec = localTerminalHostLaunchSpec(input(), { stateDir: "/state" });
    expect(spec.environment).toEqual([{ name: "PWD", value: "/work" }]);
  });

  it("drops only entries the host would skip, and refuses an environment over its caps", () => {
    const entries = localTerminalHostLaunchEnvironment({
      "BASH_FUNC_x%%": "() { echo hi; }",
      "1BAD": "x",
      NUL: "a\0b",
      BIG: "x".repeat(16 * 1024 + 1),
      KEEP: "yes",
    });
    expect(entries).toEqual([{ name: "KEEP", value: "yes" }]);
    expect(localTerminalHostLaunchEnvironment(many(300))).toHaveLength(300);
    expect(() => localTerminalHostLaunchEnvironment(many(LOCAL_LAUNCH_MAX_ENTRIES + 1))).toThrow(
      LocalTerminalHostLaunchSpecError,
    );
    const large = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`LARGE_${index}`, "x".repeat(15 * 1024)]),
    );
    expect(() => localTerminalHostLaunchEnvironment(large)).toThrow("256 KiB");
  });

  it("marks every host terminal lifecycle-managed with a local launch", () => {
    const dir = "/state/shell-integration/0123456789ab";
    const spec = localTerminalHostLaunchSpec(input({ env: integrationEnv(dir) }), {
      stateDir: "/state",
      platform: "linux",
    });
    expect(spec.hostLifecycle).toEqual({ lifecycleManaged: true, localLaunch: true });
    expect(spec.hostLifecycle).toBe(LOCAL_TERMINAL_HOST_LIFECYCLE);
    expect(spec.shellLaunch.platform).toBe("linux");
    expect(spec.environment).toContainEqual({ name: "BIGBUD_SHELL_INTEGRATION_DIR", value: dir });
  });

  it("keeps a terminal in-process when its hook paths are not under the state directory", () => {
    const outside = planLocalTerminalHostLaunch(
      input({ env: integrationEnv("/tmp/other/shell-integration/abc") }),
      { stateDir: "/state" },
    );
    expect(outside).toMatchObject({ kind: "in-process" });
    const escaped = planLocalTerminalHostLaunch(
      input({
        env: {
          ...integrationEnv("/state/shell-integration/abc"),
          BIGBUD_CLAUDE_HOOKS: "/tmp/hooks.json",
        },
      }),
      { stateDir: "/state" },
    );
    expect(escaped).toMatchObject({ kind: "in-process" });
    const orphanHook = planLocalTerminalHostLaunch(
      input({ env: { BIGBUD_CLAUDE_HOOKS: "/tmp/hooks.json" } }),
      { stateDir: "/state" },
    );
    expect(orphanHook).toMatchObject({ kind: "in-process" });
    // Without the integration there are no hook paths to keep stable.
    expect(planLocalTerminalHostLaunch(input(), { stateDir: "/state" }).kind).toBe("host");
  });

  it("mirrors the host's trusted shell list, including a root's physical spelling", () => {
    expect(localTerminalHostShellAllowed("/bin/zsh", ["-o", "nopromptsp"], realpath)).toBe(true);
    expect(localTerminalHostShellAllowed("/opt/homebrew/bin/fish", [], realpath)).toBe(true);
    expect(localTerminalHostShellAllowed("/usr/bin/bash", [], realpath)).toBe(true);
    // zsh only with its fixed arguments; other shells with none.
    expect(localTerminalHostShellAllowed("/bin/zsh", [], realpath)).toBe(false);
    expect(localTerminalHostShellAllowed("/bin/bash", ["-l"], realpath)).toBe(false);
    expect(localTerminalHostShellAllowed("/Users/me/.cargo/bin/nu", [], realpath)).toBe(false);
    expect(localTerminalHostShellAllowed("/usr/local/bin/xonsh", [], realpath)).toBe(false);
  });

  it("runs a custom shell outside the trusted list in-process instead of failing on the host", () => {
    const custom = planLocalTerminalHostLaunch(input({ shell: "/opt/tools/bin/bash", args: [] }), {
      stateDir: "/state",
      platform: "linux",
    });
    expect(custom).toMatchObject({ kind: "in-process" });
    expect(() =>
      localTerminalHostLaunchSpec(input({ shell: "/bin/bash", args: ["--login"] }), {
        stateDir: "/state",
        platform: "linux",
      }),
    ).toThrow(LocalTerminalHostLaunchSpecError);
  });

  it("still throws launch errors that are not about moving to the host", () => {
    expect(() =>
      planLocalTerminalHostLaunch(input({ shell: "definitely-not-a-shell-bbth", args: [] }), {
        stateDir: "/state",
      }),
    ).toThrow("unavailable");
  });
});
