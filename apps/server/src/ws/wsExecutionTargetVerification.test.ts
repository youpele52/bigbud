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
      installRemoteAgentEffect({
        executionTargetId: ExecutionTargetId.makeUnsafe("ssh:host=dev-vps&transport=direct-ssh"),
      }).pipe(Effect.flip),
    );
    expect(result.message).toBe(
      "This remote workspace uses Direct SSH. No bigbud remote agent installation is required.",
    );
  });
});
