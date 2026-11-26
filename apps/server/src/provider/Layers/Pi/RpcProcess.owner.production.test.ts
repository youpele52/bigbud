import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it, vi } from "vitest";

import { makeProductionCodexSshOwner } from "../../../codex/codexAppServerManager.process.remote.production.ts";
import type { PickerProofProductionProviderClient } from "../../../ssh/sshOwnerPickerProof.client.productionProvider.ts";
import { PickerProofOwnerError } from "../../../ssh/sshOwnerPickerProof.codec.wire.ts";
import type { SshOwnerProductionRegistration } from "../../../ssh/sshOwnerProductionRegistry.ts";
import {
  makeProductionPiRpcOwner,
  PiProductionResumeRefusedError,
  resolveProductionPiRpcOwner,
} from "./RpcProcess.owner.production.ts";
import { getPiRpcCapabilityDenial } from "./RpcProcess.selection.ts";

const TARGET = "ssh:host=10.0.0.5&user=dev&port=2222";
const threadId = ThreadId.makeUnsafe("thread-1");
const runtime = {
  provider: "pi" as const,
  threadId,
  sessionEpoch: 2,
  executionTargetId: TARGET,
  binaryPath: "pi",
  cwd: "/srv/work",
};

function fakeClient(code = 0): PickerProofProductionProviderClient {
  return {
    probeProvider: vi.fn(async () => ({ code, stdout: "0.70.2\n", stderr: "" })),
    openProviderLease: vi.fn(async () => {
      throw new Error("not opened in this test");
    }),
    providerLeaseStatus: vi.fn(),
    closeProviderLease: vi.fn(),
  };
}

describe("production Pi owner port", () => {
  it("probes with the session scope only and never the local binary path", async () => {
    const client = fakeClient();
    const owner = makeProductionPiRpcOwner(client, TARGET);
    await expect(owner.probeProvider(runtime, new AbortController().signal)).resolves.toBe(
      "0.70.2\n",
    );
    expect(client.probeProvider).toHaveBeenCalledWith({
      provider: "pi",
      threadId,
      sessionEpoch: 2,
      cwd: "/srv/work",
    });
  });

  it("refuses another target, a nonzero probe and a session-file resume", async () => {
    const owner = makeProductionPiRpcOwner(fakeClient(), TARGET);
    await expect(
      owner.probeProvider(
        { ...runtime, executionTargetId: "ssh:other" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "operationDenied" });
    const failing = makeProductionPiRpcOwner(fakeClient(1), TARGET);
    await expect(
      failing.probeProvider(runtime, new AbortController().signal),
    ).rejects.toMatchObject({ code: "operationDenied" });
  });

  it("probes the exact resume scope before opening and types a refused resume file", async () => {
    const client = fakeClient();
    vi.mocked(client.probeProvider).mockRejectedValueOnce(
      new PickerProofOwnerError("operationDenied"),
    );
    const owner = makeProductionPiRpcOwner(client, TARGET);
    const sessionFile = "/home/dev/.pi/agent/sessions/w/s.jsonl";
    const refused = owner.startProvider({ ...runtime, sessionFile });
    await expect(refused.ready).rejects.toBeInstanceOf(PiProductionResumeRefusedError);
    await refused.cancel();
    expect(client.probeProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "pi", sessionFile }),
    );
    expect(client.openProviderLease).not.toHaveBeenCalled();
    const admitted = owner.startProvider({ ...runtime, sessionFile });
    await expect(admitted.ready).rejects.toThrow("not opened in this test");
    expect(client.openProviderLease).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ sessionFile }),
    );
    await admitted.cancel();
  });

  it("binds only the live owner's descriptor for the exact target", async () => {
    const bound = fakeClient();
    const target = vi.fn(() => bound);
    const registration = {
      handle: { target },
      descriptorFor: async (targetId: string) => ({ targetId, kind: "structured" }),
    } as unknown as SshOwnerProductionRegistration;
    const selected = { production: () => registration };
    const resolved = await resolveProductionPiRpcOwner(TARGET, selected);
    expect(resolved?.targetId).toBe(TARGET);
    expect(target).toHaveBeenCalledTimes(1);
    expect(
      await resolveProductionPiRpcOwner(TARGET, { ...selected, production: () => undefined }),
    ).toBeUndefined();
    const mismatched = {
      ...registration,
      descriptorFor: async () => ({ targetId: "ssh:elsewhere", kind: "structured" }),
    } as unknown as SshOwnerProductionRegistration;
    expect(
      await resolveProductionPiRpcOwner(TARGET, { ...selected, production: () => mismatched }),
    ).toBeUndefined();
  });

  it("refuses a remote Pi start under activation when no owner port was resolved", () => {
    const targets = {
      providerRuntimeTarget: { location: "remote", executionTargetId: TARGET },
      workspaceTarget: { location: "remote", executionTargetId: TARGET, cwd: "/srv/work" },
    } as unknown as Parameters<typeof getPiRpcCapabilityDenial>[0];
    expect(getPiRpcCapabilityDenial(targets, "rpc-start", false)?.message).toBe(
      "Pi remote RPC start is unavailable with the production SSH owner.",
    );
    expect(getPiRpcCapabilityDenial(targets, "rpc-start", true)).toBeUndefined();
  });
});

describe("production Codex owner port", () => {
  const codexRuntime = { ...runtime, provider: "codex" as const, binaryPath: "codex" };

  it("maps the typed probe and carries a custom Codex home in the checked scope", async () => {
    const client = fakeClient();
    const owner = makeProductionCodexSshOwner(client, TARGET);
    await expect(owner.probeProvider(codexRuntime, new AbortController().signal)).resolves.toEqual({
      status: 0,
      stdout: "0.70.2\n",
      stderr: "",
    });
    await owner.probeProvider(
      { ...codexRuntime, homePath: "/home/dev/.codex" },
      new AbortController().signal,
    );
    expect(client.probeProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "codex", codexHome: "/home/dev/.codex" }),
    );
    vi.mocked(client.probeProvider).mockRejectedValueOnce(
      new PickerProofOwnerError("operationDenied"),
    );
    await expect(
      owner.probeProvider({ ...codexRuntime, homePath: "/etc" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "codex-production-home-refused" });
  });

  it("passes the question feature only as the typed scope flag", async () => {
    const client = fakeClient();
    const owner = makeProductionCodexSshOwner(client, TARGET);
    const start = owner.startProvider({ ...codexRuntime, enableDefaultModeUserInput: true });
    await expect(start.ready).rejects.toThrow("not opened in this test");
    expect(client.openProviderLease).toHaveBeenCalledWith(expect.any(Uint8Array), {
      provider: "codex",
      threadId,
      sessionEpoch: 2,
      cwd: "/srv/work",
      defaultModeUserInput: true,
    });
    await start.cancel();
  });
});
