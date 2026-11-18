import { expect, it, vi } from "vitest";
import { makeRemoteAgentControlHandler } from "./remoteAgentLocalControl.handlers.ts";
import { makeRemoteAgentInstallOperations } from "./remoteAgentInstall.operation.ts";

function fixture(stage = async () => ({ version: "0.3.4" })) {
  const operations = makeRemoteAgentInstallOperations({
    stage,
    activate: async () => ({ currentVersion: "0.3.4" }),
    retire: async () => ({ deferred: 0 }),
  });
  const hasManagedBuild = vi.fn(async () => true);
  const handle = makeRemoteAgentControlHandler({
    operations,
    hasManagedBuild,
    listSavedTargets: async () => [],
    status: async () => ({ status: "installed" }),
    doctor: async () => ({}),
  });
  return { operations, hasManagedBuild, handle };
}

it("rejects CLI install joining the app's stage-only operation as busy", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async () => {
    await gate;
    return { version: "0.3.4" };
  });
  const target = "ssh:host=vps&transport=agent";
  const stage = f.operations.start({ executionTargetId: target, replace: false, stageOnly: true });
  try {
    expect(
      await f.handle({ method: "install", target, replace: false, consent: true }),
    ).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
  } finally {
    release();
    await f.operations.wait(stage.operationId, 1_000);
  }
});

it("returns a bounded error for an expired operation", async () => {
  expect(
    await fixture().handle({ method: "operation", operationId: "expired", waitMs: 1 }),
  ).toMatchObject({
    ok: false,
    error: { code: "target" },
  });
});

it("reuses the unsaved host approval probe within one status request", async () => {
  const f = fixture();
  expect(
    await f.handle({ method: "status", target: "ssh:host=vps&transport=agent" }),
  ).toMatchObject({ ok: true });
  expect(f.hasManagedBuild).toHaveBeenCalledOnce();
});

it.each(["status", "doctor"] as const)(
  "reports unreadable approval evidence for %s without approving or probing further",
  async (method) => {
    const { readRemoteAgentApprovalEvidence } =
      await import("./remoteAgentLocalControl.approval.ts");
    const run = vi.fn(async () => ({ stdout: "unreadable", stderr: "", code: 0 }));
    const f = fixture();
    const status = vi.fn();
    const doctor = vi.fn();
    const start = vi.spyOn(f.operations, "start");
    const handle = makeRemoteAgentControlHandler({
      operations: f.operations,
      listSavedTargets: async () => [],
      hasManagedBuild: f.hasManagedBuild,
      approvalEvidence: (target) => readRemoteAgentApprovalEvidence(target, run),
      status,
      doctor,
    });
    const target = "ssh:host=vps&transport=agent";
    expect(await handle({ method, target })).toMatchObject({
      ok: true,
      result: { approved: false, health: { status: "unreadable" } },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(
      await handle({ method: "install", target, replace: false, consent: false }),
    ).toMatchObject({
      ok: true,
      result: { status: "consent-required" },
    });
    expect(start).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(doctor).not.toHaveBeenCalled();
    expect(f.hasManagedBuild).not.toHaveBeenCalled();
  },
);
