import { describe, expect, it, vi } from "vitest";

import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { getPiRpcCapabilityDenial } from "../provider/Layers/Pi/RpcProcess.selection.ts";
import { probeProductionWorkspaceReadiness } from "./remoteWorkspaceReadiness.production.ts";

const targetId = "ssh:host=devbox&user=dev&port=22";
const workspace = { location: "remote" as const, executionTargetId: targetId, cwd: "/srv/app" };

function fakeOwner(readiness: { os: string; architecture: string }) {
  const probe = vi.fn(async () => readiness);
  const registration = {
    handle: { target: () => ({ probeProofWorkspaceReadiness: probe }) },
    descriptorFor: async () => ({ targetId, kind: "structured" }),
  } as unknown as SshOwnerProductionRegistration;
  return { probe, read: () => registration };
}

describe("production workspace readiness", () => {
  it("asks the owner's typed readiness verb for the exact target and root", async () => {
    const { probe, read } = fakeOwner({ os: "Linux", architecture: "aarch64" });
    await expect(probeProductionWorkspaceReadiness(workspace, read)).resolves.toEqual({
      os: "linux",
      architecture: "aarch64",
    });
    expect(probe).toHaveBeenCalledWith({ executionTargetId: targetId, workspaceRoot: "/srv/app" });
  });

  it("refuses typed without a live owner and never falls back to a shell", async () => {
    await expect(probeProductionWorkspaceReadiness(workspace, () => undefined)).rejects.toThrow(
      /ownerUnavailable|unavailable/u,
    );
  });

  it("refuses a missing workspace root before reaching the owner", async () => {
    const { probe, read } = fakeOwner({ os: "Linux", architecture: "x86_64" });
    await expect(
      probeProductionWorkspaceReadiness({ ...workspace, cwd: undefined }, read),
    ).rejects.toThrow(/explicit workspace root/u);
    expect(probe).not.toHaveBeenCalled();
  });

  it("admits a local Pi runtime with a direct SSH workspace (bridge tools)", () => {
    expect(
      getPiRpcCapabilityDenial(
        {
          providerRuntimeTarget: { location: "local", executionTargetId: "local" },
          workspaceTarget: workspace,
        } as never,
        "rpc-start",
      ),
    ).toBeUndefined();
  });

  it("still refuses a remote Pi runtime without an owner binding", () => {
    expect(
      getPiRpcCapabilityDenial(
        {
          providerRuntimeTarget: { location: "remote", executionTargetId: targetId },
          workspaceTarget: workspace,
        } as never,
        "rpc-start",
      )?.message,
    ).toMatch(/remote RPC start is unavailable/u);
  });
});
