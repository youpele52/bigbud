import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { emptyRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import {
  remoteAgentHasManagedBuildReadOnly,
  readRemoteAgentApprovalEvidence,
} from "./remoteAgentLocalControl.approval.ts";
import {
  buildRemoteAgentRegistryReadOnlyProbe,
  remoteAgentReadOnlyStatus,
} from "./remoteAgentReadOnlyStatus.ts";

function build(version: string, digest: string, promotion: number) {
  const sha256 = digest.repeat(64);
  const generation = `g-${digest}`;
  const statePath = `/home/u/.bigbud/agent/runtimes/${generation}`;
  return {
    id: `${version}:${sha256}:x86_64-unknown-linux-musl`,
    runtime: {
      generation,
      version,
      sha256,
      buildDigest: `build-${version}`,
      targetTriple: "x86_64-unknown-linux-musl",
      origin: "managed",
      binaryPath: `/home/u/.bigbud/agent/bin/${version}/${sha256}/bigbud-remote-agent`,
      statePath,
      socketPath: `${statePath}/supervisor.sock`,
      logPath: `${statePath}/supervisor.log`,
    },
    health: "healthy",
    promotion,
    binary: "present",
    authenticated: true,
  };
}

const remote = (stdout: string, code = 0) => vi.fn(async () => ({ stdout, stderr: "", code }));

describe("read-only remote agent status", () => {
  it("is one registry read that never creates, locks or starts anything", async () => {
    expect(buildRemoteAgentRegistryReadOnlyProbe()).not.toMatch(
      /mkdir|flock|install -d|supervisor|\bln\b|\brm\b|>[^&]/,
    );
    const run = remote("absent");
    expect(await remoteAgentReadOnlyStatus("ssh:host=vps&transport=agent", run)).toMatchObject({
      status: "not-installed",
      current: null,
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports current, pending and older managed builds from the registry", async () => {
    const [old, current, next] = [
      build("0.3.2", "a", 1),
      build("0.3.3", "b", 2),
      build("0.3.4", "c", 0),
    ];
    const registry = {
      ...emptyRemoteAgentRegistry(),
      builds: [old, current, { ...next, health: "staged" }],
      current: current.id,
      pending: next.id,
      promotionSequence: 2,
    };
    expect(
      await remoteAgentReadOnlyStatus(
        "ssh:host=vps&transport=agent",
        remote(JSON.stringify(registry)),
      ),
    ).toMatchObject({
      status: "installed",
      current: { version: "0.3.3", targetTriple: "x86_64-unknown-linux-musl" },
      pending: { version: "0.3.4" },
      olderBuilds: 1,
    });
  });

  it("treats an unreadable registry as no approval evidence but reports it to status callers", async () => {
    expect(await remoteAgentHasManagedBuildReadOnly("t", remote("{not json"))).toBe(false);
    await expect(remoteAgentReadOnlyStatus("t", remote("{not json"))).rejects.toThrow();
    expect(await remoteAgentHasManagedBuildReadOnly("t", remote("", 255))).toBe(false);
  });
});

it("uses the caller's shorter tool-path timeout", async () => {
  const run = remote("absent");
  await remoteAgentReadOnlyStatus("t", run, 5_000);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5_000 }));
});

it.skipIf(process.platform === "win32")(
  "distinguishes missing registry from unsafe registry files",
  () => {
    const home = mkdtempSync(join(tmpdir(), "remote-status-"));
    const directory = join(home, ".bigbud/agent/control-v1");
    const file = join(directory, "registry.json");
    const probe = () =>
      execFileSync("sh", ["-c", buildRemoteAgentRegistryReadOnlyProbe()], {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
    try {
      mkdirSync(directory, { recursive: true });
      expect(probe()).toBe("absent");
      symlinkSync(join(home, "missing"), file);
      expect(probe()).toBe("unreadable");
      rmSync(file);
      writeFileSync(file, "x".repeat(2 * 1024 * 1024));
      expect(probe()).toBe("unreadable");
      if (process.getuid?.() !== 0) {
        chmodSync(directory, 0);
        try {
          expect(probe()).toBe("unreadable");
        } finally {
          chmodSync(directory, 0o700);
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

it("keeps missing approval evidence distinct from unreadable and installed evidence", async () => {
  expect(await readRemoteAgentApprovalEvidence("t", remote("absent"))).toEqual({
    approved: false,
    unreadable: false,
  });
  expect(await readRemoteAgentApprovalEvidence("t", remote("unreadable"))).toEqual({
    approved: false,
    unreadable: true,
  });
  expect(
    await readRemoteAgentApprovalEvidence(
      "t",
      remote(
        JSON.stringify({
          ...emptyRemoteAgentRegistry(),
          builds: [build("0.3.3", "a", 1)],
          promotionSequence: 1,
        }),
      ),
    ),
  ).toEqual({ approved: true, unreadable: false });
});
