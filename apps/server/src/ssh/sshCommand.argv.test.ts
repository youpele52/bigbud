import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { remoteReadOnlyInvocation } from "../terminal/Layers/Manager.remote-inspection.ts";
import { buildSshCommandInvocation } from "./sshCommand.ts";
import { buildSshControlArgs } from "./sshSession.control.ts";

const sshAvailable = spawnSync("ssh", ["-V"]).status === 0;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** `ssh -G` resolves the full argv (options, `--`, destination) without connecting. */
function resolveWithRealSsh(executionTargetId: string) {
  const { command, args } = buildSshCommandInvocation({ executionTargetId, command: "true" });
  return spawnSync(command, ["-G", ...args], { encoding: "utf8", timeout: 10_000 });
}

describe.skipIf(!sshAvailable)("ssh argv with the real OpenSSH client", () => {
  it("accepts the -- separator and still applies destination, user and port", () => {
    const result = resolveWithRealSsh(
      "ssh:host=example.invalid&user=dev&port=2222&transport=agent",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^hostname example\.invalid$/m);
    expect(result.stdout).toMatch(/^user dev$/m);
    expect(result.stdout).toMatch(/^port 2222$/m);
  });

  it("never interprets an option-like destination as an ssh option", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-ssh-argv-"));
    directories.push(directory);
    const marker = join(directory, "proxy-ran");
    const hostile = encodeURIComponent(`-oProxyCommand=touch ${marker}`);
    const result = resolveWithRealSsh(`ssh:host=${hostile}&transport=agent`);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/^proxycommand touch/im);
    expect(existsSync(marker)).toBe(false);
  });

  it("ends option parsing in control commands and terminal inspection too", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-ssh-argv-"));
    directories.push(directory);
    const marker = join(directory, "proxy-ran");
    const hostile = `-oProxyCommand=touch ${marker}`;
    const control = buildSshControlArgs(
      "check",
      { port: "2222" },
      { controlPath: join(directory, "s"), destination: hostile },
    );
    // `-G` replaces `-O check` so the real client only resolves the argv.
    const controlArgs = control.slice(2);
    expect(controlArgs.at(-2)).toBe("--");
    const controlResult = spawnSync("ssh", ["-G", ...controlArgs], { encoding: "utf8" });
    expect(`${controlResult.stdout}${controlResult.stderr}`).not.toMatch(/^proxycommand touch/im);

    const inspection = remoteReadOnlyInvocation(
      "ssh:host=example.invalid&user=dev&port=2222&transport=agent",
      "true",
    );
    expect(inspection.args.at(-3)).toBe("--");
    const resolved = spawnSync(inspection.command, ["-G", ...inspection.args], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(resolved.stdout).toMatch(/^hostname example\.invalid$/m);
    expect(existsSync(marker)).toBe(false);
  });
});
