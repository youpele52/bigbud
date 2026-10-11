import { describe, expect, it } from "vitest";
import {
  buildWslTerminalShellCandidate,
  WSL_CWD_FAILURE_OUTPUT,
  WSL_PATH_SCRIPT,
  wslProbeArgs,
} from "./Manager.wsl.invocation";
import { formatShellCandidate } from "./Manager.shell";
import { runProcess } from "../../utils/processRunner";

describe("WSL argv and final spawn", () => {
  const identity = { distribution: 'dev & %PATH% "x"', username: "alice", uid: 1000 };
  it("pins distro/user while keeping hostile paths and env out of fixed shell source", () => {
    const cwd = '/project/"; touch /wrong #';
    const candidate = buildWslTerminalShellCandidate({
      wslIdentity: identity,
      cwd,
      runtimeEnv: { SECRET: "$(touch /wrong) & %X%" },
    });
    expect(candidate.args?.slice(0, 4)).toEqual([
      "--distribution",
      identity.distribution,
      "--user",
      "alice",
    ]);
    expect(candidate.args).toContain(cwd);
    expect(candidate.args).toContain("SECRET=$(touch /wrong) & %X%");
    const script = candidate.args?.[candidate.args.indexOf("-c") + 1];
    expect(script).toContain('test "$(id -u)" = "$2"');
    expect(script).toContain('cd "$1"');
    expect(script).not.toContain(cwd);
    expect(script).not.toContain("SECRET");
    expect(formatShellCandidate(candidate)).not.toContain("SECRET");
    expect(candidate.dropPathMode).toBe("posix");
  });
  it("path translation is an explicit guest utility, never a guessed mount", () => {
    const args = wslProbeArgs({
      distribution: "Ubuntu",
      identity: { ...identity, distribution: "Ubuntu" },
      script: WSL_PATH_SCRIPT,
      args: ["alice", "1000", "C:\\a & b", "windows", "directory"],
    });
    expect(args.at(-3)).toBe("C:\\a & b");
    expect(WSL_PATH_SCRIPT).toContain('wslpath -a -u "$p"');
    expect(WSL_PATH_SCRIPT).not.toContain("/mnt/");
  });
  it("rejects missing identity and invalid environment data", () => {
    expect(() => buildWslTerminalShellCandidate({ cwd: "/", runtimeEnv: {} })).toThrow(
      "not been resolved",
    );
    expect(() =>
      wslProbeArgs({ distribution: "Ubuntu", script: "true", env: { "BAD=KEY": "x" } }),
    ).toThrow();
    expect(() =>
      wslProbeArgs({ distribution: "Ubuntu", script: "true", env: { FOO: "a\0b" } }),
    ).toThrow();
  });
  it.skipIf(process.platform === "win32")(
    "executes fixed POSIX probes with literal argv and rejects UID/user discontinuity",
    async () => {
      const stubs =
        'id() { case "$1" in -un) printf alice;; -u) printf 1000;; esac; }; wslpath() { printf "/safe/project"; }; ';
      const execute = (script: string, args: string[]) =>
        runProcess("/bin/sh", ["-c", script, "sh", ...args], {
          shell: false,
          allowNonZeroExit: true,
        });
      const mapped = await execute(stubs + WSL_PATH_SCRIPT, [
        "alice",
        "1000",
        'C:\\project & $(printf wrong) "quoted"',
        "windows",
        "path",
      ]);
      expect(mapped.code).toBe(0);
      expect(mapped.stdout).toBe("path\0/safe/project\0");
      const home = await execute(stubs + WSL_PATH_SCRIPT, [
        "alice",
        "1000",
        "~/Documents",
        "linux",
        "path",
      ]);
      expect(home.stdout).toBe(`path\0${process.env.HOME}/Documents\0`);
      expect(
        (await execute(stubs + WSL_PATH_SCRIPT, ["alice", "1001", "/", "linux", "directory"])).code,
      ).toBe(79);
      expect(
        (await execute(stubs + WSL_PATH_SCRIPT, ["bob", "1000", "/", "linux", "directory"])).code,
      ).toBe(79);
      const missing = await execute(stubs + WSL_PATH_SCRIPT, [
        "alice",
        "1000",
        "/nonexistent-wsl-terminal-probe-folder",
        "linux",
        "directory",
      ]);
      expect(missing.code).toBe(77);
      expect(missing.stdout).toBe(WSL_CWD_FAILURE_OUTPUT);
    },
  );
});
