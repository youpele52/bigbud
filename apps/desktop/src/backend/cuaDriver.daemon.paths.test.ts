import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { unixSocketPathMaxBytes } from "@bigbud/shared/privateSocketPath";
import { afterEach, describe, expect, it } from "vitest";

import { removeStaleDaemonSocket } from "./cuaDriver.daemon.endpoint";
import { resolvePrivateEndpoint } from "./cuaDriver.daemon.paths";

// A deliberately long home: every channel base dir must still yield a bindable socket.
const LONG_HOME = `/Users/${"a-very-long-account-name-".repeat(4)}`;
const CHANNEL_BASES = {
  stable: Path.join(LONG_HOME, ".bigbud"),
  beta: Path.join(LONG_HOME, ".bigbud", "channels", "beta"),
  nightly: Path.join(LONG_HOME, ".bigbud", "channels", "nightly"),
  dev: Path.join(LONG_HOME, ".bigbud", "dev"),
};

const runDirs: string[] = [];
afterEach(() => {
  for (const runDir of runDirs.splice(0)) FS.rmSync(runDir, { recursive: true, force: true });
});

describe.skipIf(OS.platform() === "win32")("resolvePrivateEndpoint", () => {
  it("keeps the socket under the platform limit for long homes and every channel", () => {
    const limit = Math.min(unixSocketPathMaxBytes("darwin"), unixSocketPathMaxBytes("linux"));
    expect(Buffer.byteLength(CHANNEL_BASES.beta)).toBeGreaterThan(limit);
    for (const baseDir of Object.values(CHANNEL_BASES)) {
      const resolved = resolvePrivateEndpoint(baseDir);
      runDirs.push(resolved.runDir);
      expect(Buffer.byteLength(resolved.endpoint)).toBeLessThanOrEqual(limit);
      expect(resolved.endpoint.startsWith(`/tmp/bigbud-${process.getuid!()}/cua-`)).toBe(true);
      expect(FS.lstatSync(resolved.runDir).mode & 0o777).toBe(0o700);
    }
  });

  it("separates channels and runs", () => {
    const stable = resolvePrivateEndpoint(CHANNEL_BASES.stable);
    const beta = resolvePrivateEndpoint(CHANNEL_BASES.beta);
    const betaAgain = resolvePrivateEndpoint(CHANNEL_BASES.beta);
    runDirs.push(stable.runDir, beta.runDir, betaAgain.runDir);
    const tag = (runDir: string) => Path.basename(runDir).split("-")[1];
    expect(tag(stable.runDir)).not.toBe(tag(beta.runDir));
    expect(tag(beta.runDir)).toBe(tag(betaAgain.runDir));
    expect(beta.runDir).not.toBe(betaAgain.runDir);
  });

  it("keeps socket and PID file in the run dir so stale-socket cleanup stays scoped", () => {
    const resolved = resolvePrivateEndpoint(CHANNEL_BASES.beta);
    runDirs.push(resolved.runDir);
    expect(Path.dirname(resolved.endpoint)).toBe(resolved.runDir);
    expect(Path.dirname(resolved.pidFile)).toBe(resolved.runDir);
    expect(removeStaleDaemonSocket(resolved.endpoint, resolved.runDir)).toBe("absent");
  });

  it("removes the run dir and reports clearly when the socket cannot fit", () => {
    const parent = FS.mkdtempSync(Path.join("/tmp", "x".repeat(96)));
    runDirs.push(parent);
    expect(() =>
      resolvePrivateEndpoint(CHANNEL_BASES.beta, { platform: "darwin", tmpRoot: parent }),
    ).toThrow(/Unix socket path is \d+ bytes but darwin allows at most 103/);
    const root = Path.join(parent, `bigbud-${process.getuid!()}`);
    expect(FS.readdirSync(root)).toEqual([]);
  });
});
