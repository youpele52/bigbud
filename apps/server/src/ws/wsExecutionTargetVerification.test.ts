import { RemoteAgentCapacityUnavailableError } from "../remote-agent/remoteAgentInstall.stage.ts";
import { RemoteAgentRemoteCommandError } from "../remote-agent/remoteAgentDiagnostics.ts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";

vi.mock("../ssh/sshVerification.ts", () => ({
  verifySshExecutionTarget: vi.fn(async () => ({ message: "SSH access is available." })),
  unlockSshExecutionTargetCredential: vi.fn(),
  unlockSshExecutionTargetKey: vi.fn(),
}));
vi.mock("../remote-agent/remoteAgentDefault.ts", () => ({
  isRemoteAgentExecutionTarget: (target: string) => target.includes("transport=agent"),
}));

import { makeRemoteAgentInstallOperations } from "../remote-agent/remoteAgentInstall.operation.ts";
import {
  installRemoteAgentEffect,
  verifyExecutionTargetEffect,
} from "./wsExecutionTargetVerification.ts";

const executionTargetId = ExecutionTargetId.makeUnsafe("ssh:host=dev-vps&transport=agent");

describe("remote workspace setup copy", () => {
  it("names the remote workspace when installation is required", async () => {
    const result = await Effect.runPromise(
      verifyExecutionTargetEffect(
        { executionTargetId },
        {
          verify: async () => ({ status: "install-required" }),
        },
      ),
    );
    expect(result.message).toContain("before this remote workspace can be created.");
    expect(result.remoteAgent).toEqual({ status: "install-required" });
  });

  it("keeps upgrade versions while naming the remote workspace", async () => {
    const result = await Effect.runPromise(
      verifyExecutionTargetEffect(
        { executionTargetId },
        {
          verify: async () => ({
            status: "upgrade-required",
            currentVersion: "1",
            targetVersion: "2",
          }),
        },
      ),
    );
    expect(result.message).toContain(
      "upgraded from 1 to 2 before this remote workspace can be used.",
    );
    expect(result.remoteAgent).toEqual({
      status: "upgrade-required",
      currentVersion: "1",
      targetVersion: "2",
    });
  });

  it("explains that a Direct SSH workspace needs no agent installation", async () => {
    const result = await Effect.runPromise(
      installRemoteAgentEffect(
        {
          executionTargetId: ExecutionTargetId.makeUnsafe("ssh:host=dev-vps&transport=direct-ssh"),
        },
        {},
      ).pipe(Effect.flip),
    );
    expect(result.message).toBe(
      "This remote workspace uses Direct SSH. No bigbud remote agent installation is required.",
    );
  });

  describe("app Install through the shared operation registry (D6)", () => {
    const target = ExecutionTargetId.makeUnsafe("ssh:host=dev-vps&transport=agent");
    const installer = { install: vi.fn() };

    it.each([
      [new RemoteAgentCapacityUnavailableError("waiting-for-capacity"), "deferred"],
      [new RemoteAgentRemoteCommandError("install", 75, false, "busy"), "deferred"],
      [new RemoteAgentRemoteCommandError("install", 255, false, "Broken pipe"), "uncertain"],
    ] as const)("preserves pre-stage replacement outcome %s", async (cause, outcome) => {
      const operations = makeRemoteAgentInstallOperations({
        stage: async () => {
          throw cause;
        },
        activate: vi.fn(),
        retire: vi.fn(),
      });
      const result = await Effect.runPromise(
        installRemoteAgentEffect(
          { executionTargetId: target, replace: true },
          {
            remoteAgentInstaller: installer,
            remoteAgentInstallOperations: operations,
          },
        ),
      );
      expect(result).toMatchObject({ outcome });
      expect(result.version).toBeUndefined();
    });

    it("replaces through the shared operation and reports deferred cleanup truthfully", async () => {
      const operations = makeRemoteAgentInstallOperations({
        stage: async () => ({ version: "0.3.4", buildId: "new" }),
        activate: async () => ({ currentVersion: "0.3.4", currentBuildId: "new" }),
        retire: async () => ({ deferred: 1 }),
      });
      const result = await Effect.runPromise(
        installRemoteAgentEffect(
          { executionTargetId: target, replace: true },
          {
            remoteAgentInstaller: installer,
            remoteAgentInstallOperations: operations,
          },
        ),
      );
      expect(result).toMatchObject({ outcome: "active", cleanupDeferred: true });
      expect(result.message).toContain("Cleanup of older builds is deferred");
    });

    it("stages only, keeps placement details and leaves activation to Finish", async () => {
      const dependencies = {
        stage: vi.fn(async () => ({ version: "0.3.4", buildId: "b", placement: "inbox" as const })),
        activate: vi.fn(),
        retire: vi.fn(),
      };
      const result = await Effect.runPromise(
        installRemoteAgentEffect(
          { executionTargetId: target },
          {
            remoteAgentInstaller: installer,
            remoteAgentInstallOperations: makeRemoteAgentInstallOperations(dependencies),
          },
        ),
      );
      expect(result.message).toBe(
        "Update 0.3.4 staged from the agent you placed on the remote host. It will be used on your next new connection.",
      );
      expect(dependencies.activate).not.toHaveBeenCalled();
      expect(installer.install).not.toHaveBeenCalled();
    });

    it.each(["active", "deferred", "failed"])(
      "joins a CLI install with %s activation without staging twice",
      async (outcome) => {
        let release!: () => void;
        const dependencies = {
          stage: vi.fn(
            () =>
              new Promise<{ version: string }>(
                (resolve) => (release = () => resolve({ version: "0.3.4" })),
              ),
          ),
          activate: vi.fn(async () => {
            if (outcome === "failed") throw new Error("activation failed");
            return { currentVersion: outcome === "active" ? "0.3.4" : "0.3.3" };
          }),
          retire: vi.fn(async () => ({ deferred: 0 })),
        };
        const operations = makeRemoteAgentInstallOperations(dependencies);
        operations.start({ executionTargetId: target, replace: false });
        const app = Effect.runPromise(
          installRemoteAgentEffect(
            { executionTargetId: target },
            { remoteAgentInstaller: installer, remoteAgentInstallOperations: operations },
          ),
        );
        release();
        expect((await app).message).toBe(
          outcome === "active"
            ? "Remote agent 0.3.4 is already active."
            : "Update 0.3.4 staged. It will be used on your next new connection.",
        );
        expect(dependencies.stage).toHaveBeenCalledOnce();
      },
    );

    it("surfaces a failed staging as the install error", async () => {
      const operations = makeRemoteAgentInstallOperations({
        stage: vi.fn(async () => {
          throw new Error("remote disk full");
        }),
        activate: vi.fn(),
        retire: vi.fn(),
      });
      const error = await Effect.runPromise(
        installRemoteAgentEffect(
          { executionTargetId: target },
          { remoteAgentInstaller: installer, remoteAgentInstallOperations: operations },
        ).pipe(Effect.flip),
      );
      expect(error.message).toContain("remote disk full");
    });
  });
});
