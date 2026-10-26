import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import * as Identity from "./Orchestration.plugin.identity.ts";
import { withV2ProductionThreadTools } from "./Orchestration.production.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { decodeV2EnrollmentRecord } from "./Orchestration.enrollment.record.ts";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";
import { v2InstructionEntries } from "./Runtime.instructions.ts";

vi.mock("../../../remote-workspace-bridge/remoteWorkspaceReadiness.ts", () => ({
  probeRemoteWorkspaceReadiness: async () => ({ os: "linux", architecture: "x86_64" }),
}));

it("enrolls the synthetic local Location with the unchanged bootstrap while remote authority stays target-bound", async () => {
  const render = Identity.renderV2ThreadIdentity;
  const installed = vi
    .spyOn(Identity, "renderV2ThreadIdentity")
    .mockImplementation((key) =>
      render(key).replace(
        "!bounded(owner.workspaceTargetId)",
        'owner.workspaceTargetId !== "local"',
      ),
    );
  try {
    await withV2ProductionThreadTools(
      async ({ runtime, source, artifact, invoke }) => {
        expect(source.session.workspaceExecutionTargetId).toBe("ssh:vps");
        expect(source.resources?.remoteWorkspace).toMatchObject({
          executionTargetId: "ssh:vps",
          cwd: "/srv/project",
        });
        expect(source.native.location.directory).not.toBe("/srv/project");
        const records = await V2ThreadRecords.open(
          artifact.root,
          "enrollments",
          artifact.privateKey,
          artifact.publicKey,
        );
        const owner = (await records.entries())
          .map((entry) => decodeV2EnrollmentRecord(entry.value).owner)
          .find((owner) => owner.nativeSessionId === source.native.id)!;
        expect(owner).toMatchObject({
          runtimeTargetId: "local",
          workspaceTargetId: "local",
          directory: source.native.location.directory,
        });
        const admission = await Effect.runPromise(
          runtime.options.journal.latestBound(source.threadId),
        );
        expect(admission?.binding).toMatchObject({
          runtimeTargetId: "local",
          workspaceTargetId: "ssh:vps",
          location: owner.directory,
        });
        for (const action of ["read", "edit", "shell", "skill", "subagent", "unknown_plugin"])
          expect(v2PermissionEffect(source.toolPolicy!, action, "*")).toBe("deny");
        expect(
          v2PermissionEffect(
            source.toolPolicy!,
            `${source.resources!.remoteWorkspace!.serverName}_read`,
            "*",
          ),
        ).toBe("allow");
        expect(JSON.stringify(v2InstructionEntries(source))).toContain(
          "never fall back to local paths",
        );
        await expect(invoke("list_threads", {})).resolves.toMatchObject({ ok: true });
      },
      "full-access",
      undefined,
      true,
    );
  } finally {
    installed.mockRestore();
  }
});
