import { describe, expect, it, vi } from "vitest";

import { buildRemoteAgentInstallPaths } from "./remoteAgentInstall.ts";
import { runRemoteAgentActivationTransaction } from "./remoteAgentInstall.transaction.ts";

describe("remote agent activation recovery errors", () => {
  it("retains the original preparation failure when legacy recovery is refused", async () => {
    const artifact = {
      version: "0.2.207",
      buildDigest: "candidate",
      protocolMajor: 1,
      protocolMinor: 2,
      targetTriple: "aarch64-unknown-linux-gnu" as const,
      sizeBytes: 1,
      sha256: "a".repeat(64),
      signature: { algorithm: "ed25519" as const, keyId: "test", value: "test" },
      bundledPath: "agent",
    };
    const runRemoteCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "activated\n" })
      .mockRejectedValueOnce(new Error("blocked by active terminals or process operations"))
      .mockResolvedValueOnce({ stdout: "restored\n" })
      .mockRejectedValueOnce(new Error("0.2.205 does not support safe supervisor preparation"));
    const result = runRemoteAgentActivationTransaction({
      executionTargetId: "local-fixture",
      artifact,
      paths: buildRemoteAgentInstallPaths(artifact),
      runRemoteCommand,
      verifyInstalledAgent: async () => undefined,
    });
    await expect(result).rejects.toThrow(
      "Remote agent candidate failed verification: blocked by active terminals or process operations; rollback failed: 0.2.205 does not support safe supervisor preparation",
    );
    expect(runRemoteCommand).toHaveBeenCalledTimes(4);
  });
});
