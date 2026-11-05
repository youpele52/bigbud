import * as FS from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./cuaDriver.mcpClient", () => ({ callCuaDriverTool: vi.fn() }));
import { callCuaDriverTool } from "./cuaDriver.mcpClient";
import { validateCuaDriverPolicyEnforcement } from "./cuaDriver.policyProbe";
const options = { socketPath: "/socket", environment: {} };
beforeEach(() => vi.resetAllMocks());
const captured091 = JSON.parse(
  FS.readFileSync(
    new URL("../../../../scripts/fixtures/cua-driver/0.9.1/action-outcomes.json", import.meta.url),
    "utf8",
  ),
) as { denied: { jsonRpcError: string } };
const legacyDenial = (JSON.parse(captured091.denied.jsonRpcError) as { message: string }).message;
it.each([
  ["captured 0.9.1 JSON-RPC error", legacyDenial],
  ["0.38 tool error", "Permission denied: user policy: tool 'kill_app' is explicitly denied"],
])("accepts %s without passing any kill target", async (_label, message) => {
  vi.mocked(callCuaDriverTool).mockRejectedValue(new Error(message));
  await validateCuaDriverPolicyEnforcement("/driver", options);
  expect(callCuaDriverTool).toHaveBeenCalledWith(
    "/driver",
    "kill_app",
    {},
    { ...options, allowUnadvertisedTool: true },
  );
});
it.each([
  "Missing name",
  "Unknown tool kill_app",
  "Permission denied: OS permissions",
  "Permission denied: kill_app requires OS permission",
  "Permission denied: policy could not authorize kill_app",
  "Permission denied: tool 'launch_app' is explicitly denied",
  "Permission denied: tool 'kill_app' is explicitly denied temporarily by OS permissions",
])("rejects non-policy failure %s", async (message) => {
  vi.mocked(callCuaDriverTool).mockRejectedValue(new Error(message));
  await expect(validateCuaDriverPolicyEnforcement("/driver", options)).rejects.toThrow(
    "did not confirm policy denial",
  );
});
it("rejects policy-ignoring success", async () => {
  vi.mocked(callCuaDriverTool).mockResolvedValue({});
  await expect(validateCuaDriverPolicyEnforcement("/driver", options)).rejects.toThrow(
    "did not deny",
  );
});
