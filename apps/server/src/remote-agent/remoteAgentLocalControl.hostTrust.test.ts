import { readRemoteAgentDoctor } from "./remoteAgentLocalControl.doctor.ts";
import { expect, it, vi } from "vitest";
import { remoteAgentFailureDetail } from "./remoteAgentFailure.ts";
import { classifyRemoteAgentFailure } from "./remoteAgentFailure.classify.ts";
import { makeRemoteAgentControlHandler } from "./remoteAgentLocalControl.handlers.ts";
import { readRemoteAgentApprovalEvidence } from "./remoteAgentLocalControl.approval.ts";
import { makeRemoteAgentInstallOperations } from "./remoteAgentInstall.operation.ts";

const unknown = new Error(
  'SSH host trust is required: {"challengeId":"opaque","fingerprint":"SHA256:fixture","host":"fixture"}',
);
const changed = new Error(
  "The SSH server's identity has changed or was revoked. Connection blocked. Verify the server with your administrator before updating known_hosts.",
);
it.each([unknown, changed])(
  "classifies a host-trust failure without exposing challenge JSON: %s",
  (error) => {
    const wrapped = new Error("outer", { cause: error });
    expect(classifyRemoteAgentFailure(wrapped)?.kind).toBe("ssh-host-trust");
    const message = remoteAgentFailureDetail(wrapped);
    expect(message).toMatch(/SSH server/);
    expect(message).not.toContain("challengeId");
    expect(message).not.toContain("{");
  },
);
it.each([unknown, changed])(
  "blocks read-only requests on host trust while preserving approval refusal: %s",
  async (error) => {
    const run = vi.fn(async () => {
      throw error;
    });
    const evidence = await readRemoteAgentApprovalEvidence("ssh:fixture", run);
    expect(evidence).toMatchObject({
      approved: false,
      unreadable: true,
      hostTrustFailure: expect.any(String),
    });
    const stage = vi.fn(async () => ({ version: "fixture" }));
    const operations = makeRemoteAgentInstallOperations({
      stage,
      activate: async () => ({ currentVersion: "fixture" }),
      retire: async () => ({ deferred: 0 }),
    });
    const status = vi.fn();
    const doctor = vi.fn();
    const handle = makeRemoteAgentControlHandler({
      operations,
      status,
      doctor,
      listSavedTargets: async () => [],
      hasManagedBuild: async () => false,
      approvalEvidence: (target) => readRemoteAgentApprovalEvidence(target, run),
    });
    const target = "ssh:host=fixture&transport=agent";
    for (const request of [
      { method: "status", target } as const,
      { method: "doctor", target } as const,
      { method: "install", target, consent: false, replace: false } as const,
    ]) {
      expect(await handle(request)).toMatchObject({
        ok: false,
        error: { code: "unavailable", message: evidence.hostTrustFailure },
      });
    }
    expect(stage).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(doctor).not.toHaveBeenCalled();
  },
);
it("keeps a consented install failure actionable through its durable operation result", async () => {
  const operations = makeRemoteAgentInstallOperations({
    stage: async () => {
      throw unknown;
    },
    activate: async () => ({ currentVersion: "fixture" }),
    retire: async () => ({ deferred: 0 }),
  });
  const started = operations.start({
    executionTargetId: "ssh:host=fixture&transport=agent",
    replace: false,
  });
  const result = await operations.wait(started.operationId, 1000);
  expect(result).toMatchObject({
    state: "completed",
    outcome: "failed",
    failureKind: "ssh-host-trust",
  });
  expect(result?.message).not.toContain("challengeId");
});

it("fails saved-host doctor when the second connection loses host trust", async () => {
  const target = "ssh:host=fixture&transport=agent";
  const operations = makeRemoteAgentInstallOperations({
    stage: async () => ({ version: "fixture" }),
    activate: async () => ({ currentVersion: "fixture" }),
    retire: async () => ({ deferred: 0 }),
  });
  const platform = vi.fn(async () => ({ os: "linux" }));
  const registry = vi.fn(async () => {
    throw unknown;
  });
  const handle = makeRemoteAgentControlHandler({
    operations,
    listSavedTargets: async () => [{ executionTargetId: target, deleted: false }],
    hasManagedBuild: async () => true,
    status: async () => ({}),
    doctor: (target) => readRemoteAgentDoctor(target, platform, registry),
  });
  const result = await handle({ method: "doctor", target });
  expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(JSON.stringify(result)).not.toContain("challengeId");
  expect(platform).toHaveBeenCalledOnce();
  expect(registry).toHaveBeenCalledOnce();
});
