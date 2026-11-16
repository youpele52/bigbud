import { expect, it, vi } from "vitest";
vi.mock("./remoteAgentActivation.ts", () => ({
  activateRemoteAgentFresh: vi.fn(async () => ({
    currentVersion: "0.3.4",
    currentBuildId: "build",
    warning: "Update preparation deferred.",
  })),
}));
import { makeLiveRemoteAgentInstallOperations } from "./remoteAgentInstall.operation.live.ts";

it("preserves activation warnings through the live adapter and active result", async () => {
  const operations = makeLiveRemoteAgentInstallOperations({
    install: async () => ({ version: "0.3.4", buildId: "build" }),
  });
  const started = operations.start({ executionTargetId: "ssh:fixture", replace: false });
  const result = await operations.wait(started.operationId, 1_000);
  expect(result?.outcome).toBe("active");
  expect(result?.message).toContain("Update preparation deferred.");
});
