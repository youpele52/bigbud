import type {
  CopilotRuntimeInput,
  CopilotRuntimeState,
} from "@bigbud/contracts/server/copilotRuntime";
import { describe, expect, it } from "vitest";
import { rpcClientMock } from "./wsNativeApi.test.helpers";

const state: CopilotRuntimeState = {
  available: false,
  source: "missing",
  path: null,
  version: null,
  installedSizeBytes: null,
  managed: [],
  activeLeases: 0,
  onboarding: false,
  pinnedVersion: "1.0.103",
  job: null,
  error: null,
  diagnostic: null,
};
describe("Copilot runtime native API", () => {
  it.each(["status", "install", "update", "uninstall", "cancel", "acknowledge"] as const)(
    "forwards %s without changing lifecycle semantics",
    async (action) => {
      rpcClientMock.server.copilotRuntime.mockResolvedValue(state);
      const { createWsNativeApi } = await import("./wsNativeApi");
      const input: CopilotRuntimeInput = {
        action,
        ...(action === "cancel" ? { jobId: "00000000-0000-0000-0000-000000000000" } : {}),
      };
      await expect(createWsNativeApi().server.copilotRuntime?.(input)).resolves.toEqual(state);
      expect(rpcClientMock.server.copilotRuntime).toHaveBeenCalledWith(input);
      expect(rpcClientMock.server.updateSettings).not.toHaveBeenCalled();
    },
  );
});
