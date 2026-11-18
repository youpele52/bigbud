import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Ownership from "@bigbud/shared/backendOwnership.record";

import { describe, expect, it, vi } from "vitest";

import { buildSshCommandInvocation } from "../ssh/sshCommand.ts";
import { runRemoteAgentDiagnosedCommand } from "./remoteAgentDiagnostics.ts";
import { makeRemoteAgentInstallOperations } from "./remoteAgentInstall.operation.ts";
import { buildRemoteAgentRegistryReadOnlyProbe } from "./remoteAgentLocalControl.approval.ts";
import { makeRemoteAgentControlHandler } from "./remoteAgentLocalControl.handlers.ts";
import { resolveRemoteAgentTarget } from "./remoteAgentLocalControl.targets.ts";

import {
  RemoteAgentBackendUnavailableError,
  sendRemoteAgentControlRequest,
} from "./remoteAgentLocalControl.client.ts";

it("never claims a live backend when lock ownership cannot be verified", async () => {
  const reader = vi
    .spyOn(Ownership, "readOwnershipLock")
    .mockRejectedValue(new Error("owner_unverified"));
  try {
    const request = sendRemoteAgentControlRequest(
      join(tmpdir(), `bb-${randomUUID().slice(0, 8)}`, "control", "remote-agent.sock"),
      { method: "status", target: "vps" },
      1_000,
      { transport: "unix-socket" },
    );
    await expect(request).rejects.toMatchObject({
      message: "bigbud is not running. Start the bigbud app (or `bigbud` server), then retry.",
    });
    await expect(request).rejects.toBeInstanceOf(RemoteAgentBackendUnavailableError);
    if (process.platform !== "win32") expect(reader).toHaveBeenCalledOnce();
    else expect(reader).not.toHaveBeenCalled();
  } finally {
    reader.mockRestore();
  }
});

const saved = "ssh:host=vps&user=dev&transport=agent";

function handler(
  options: { savedTargetsOnly?: boolean; stage?: () => Promise<{ version: string }> } = {},
) {
  const status = vi.fn(async () => ({ status: "ready" }));
  const hasManagedBuild = vi.fn(async () => false);
  const operations = makeRemoteAgentInstallOperations({
    stage: options.stage ?? (async () => ({ version: "0.3.4" })),
    activate: async () => ({ currentVersion: "0.3.4" }),
    retire: async () => ({ deferred: 0 }),
  });
  const handle = makeRemoteAgentControlHandler({
    operations,
    listSavedTargets: async () => [{ executionTargetId: saved, deleted: false }],
    hasManagedBuild,
    status,
    doctor: async () => ({}),
    ...(options.savedTargetsOnly ? { savedTargetsOnly: true } : {}),
  });
  return { handle, status, hasManagedBuild };
}

describe("remote agent control target safety", () => {
  it.each([
    "ssh:host=-oProxyCommand%3Dsh%20-c%20id&transport=agent",
    "ssh:host=vps&user=-oProxyCommand%3Did&transport=agent",
    "ssh:host=vps%0Aevil&transport=agent",
  ])("rejects option-like or control-character destinations: %s", (target) => {
    expect(resolveRemoteAgentTarget(target, [])).toMatchObject({ ok: false });
  });

  it("ends ssh option parsing before the destination", () => {
    const { args } = buildSshCommandInvocation({ executionTargetId: saved, command: "true" });
    expect(args[args.indexOf("dev@vps") - 1]).toBe("--");
  });

  it("limits agent tools to saved targets", async () => {
    const tool = handler({ savedTargetsOnly: true });
    expect(
      await tool.handle({ method: "status", target: "ssh:host=other&transport=agent" }),
    ).toMatchObject({ ok: false, error: { code: "target" } });
    expect(await tool.handle({ method: "status", target: "dev@vps" })).toMatchObject({ ok: true });
  });

  it("never contacts an unsaved, unapproved host beyond the read-only approval probe", async () => {
    const cli = handler();
    expect(
      await cli.handle({ method: "status", target: "ssh:host=other&transport=agent" }),
    ).toMatchObject({ ok: true, result: { approved: false, health: "not-checked" } });
    expect(cli.status).not.toHaveBeenCalled();
    expect(cli.hasManagedBuild).toHaveBeenCalledOnce();
    expect(buildRemoteAgentRegistryReadOnlyProbe()).not.toMatch(/mkdir|flock|install -d|>/);
  });

  it("refuses to report a replace that joined a running plain install", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cli = handler({ stage: async () => (await gate, { version: "0.3.4" }) });
    expect(
      await cli.handle({ method: "install", target: "vps", replace: false, consent: false }),
    ).toMatchObject({ ok: true, result: { kind: "install" } });
    expect(
      await cli.handle({ method: "install", target: "vps", replace: true, consent: false }),
    ).toMatchObject({ ok: false, error: { code: "busy" } });
    release();
  });

  it("treats a signal-killed remote command as failed", async () => {
    await expect(
      runRemoteAgentDiagnosedCommand(
        async () => ({ stdout: "", stderr: "", code: null, signal: "SIGKILL" }),
        "install",
        { executionTargetId: saved, command: "sh" },
      ),
    ).rejects.toThrow("failed");
  });
});
