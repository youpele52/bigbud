import { describe, expect, it, vi } from "vitest";

import { compileRemoteAgentControlOp, runRemoteAgentControlOp } from "./remoteAgentControl.ops.ts";
import { buildRemoteAgentRegistryRead } from "./remoteAgentInstall.registry.shell.ts";
import { buildRemoteAgentRemovalCommand } from "./remoteAgentInstall.remove.deletion.ts";
import { REMOTE_AGENT_REMOVAL_TIMEOUT_MS } from "./remoteAgentInstall.remove.ts";
import { buildRemoteAgentSupervisorShutdownCommand } from "./remoteAgentSupervisor.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

const ROOT = "/home/dev/.bigbud/agent";
const SHA = "a".repeat(64);
const runtime: RemoteAgentRuntime = {
  generation: "g-1",
  version: "0.9.0",
  sha256: SHA,
  buildDigest: "build:1",
  targetTriple: "aarch64-unknown-linux-gnu",
  binaryPath: `${ROOT}/bin/0.9.0/${SHA}/bigbud-remote-agent`,
  statePath: `${ROOT}/runtimes/g-1`,
  socketPath: `${ROOT}/runtimes/g-1/supervisor.sock`,
  logPath: `${ROOT}/runtimes/g-1/supervisor.log`,
  origin: "managed",
};

describe("U25 typed remote-agent control operations", () => {
  it("compile to the legacy builders' scripts byte for byte", () => {
    expect(compileRemoteAgentControlOp(ROOT, { kind: "registryRead" })).toBe(
      buildRemoteAgentRegistryRead(ROOT),
    );
    expect(compileRemoteAgentControlOp(ROOT, { kind: "supervisorShutdown", runtime })).toBe(
      buildRemoteAgentSupervisorShutdownCommand(runtime),
    );
    expect(compileRemoteAgentControlOp(ROOT, { kind: "removal", fenceId: "fence-0001" })).toBe(
      buildRemoteAgentRemovalCommand(ROOT, { mode: "remove", fenceId: "fence-0001" }),
    );
  });

  it("runs a legacy control with the legacy script and deadline", async () => {
    const run = vi.fn(async () => "removed");
    await runRemoteAgentControlOp({ root: ROOT, run }, { kind: "removal", fenceId: "fence-0001" });
    expect(run).toHaveBeenCalledWith(
      buildRemoteAgentRemovalCommand(ROOT, { mode: "remove", fenceId: "fence-0001" }),
      { timeoutMs: REMOTE_AGENT_REMOVAL_TIMEOUT_MS },
    );
  });

  it("hands a production control the typed operation and never script text", async () => {
    const run = vi.fn(async () => "never");
    const exec = vi.fn(async () => "clock=1\nmissing");
    await runRemoteAgentControlOp({ root: ROOT, run, exec }, { kind: "registryRead" });
    expect(exec).toHaveBeenCalledWith({ kind: "registryRead" });
    expect(run).not.toHaveBeenCalled();
  });
});
