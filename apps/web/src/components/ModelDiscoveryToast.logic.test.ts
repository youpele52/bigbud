import { describe, expect, it } from "vitest";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { getModelDiscoveryToast } from "./ModelDiscoveryToast.logic";

function snapshot(status: "retrying" | "recovered" | "exhausted", attempt = 1): ServerProvider {
  return {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-30T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    modelRecovery: {
      status,
      attempt,
      maxAttempts: 3,
      generation: 1,
      operationId: "models:1",
      trigger: "background",
    },
  };
}
describe("model discovery toast", () => {
  it("shows blue progress with actual retry counts and a stable replay key", () => {
    const value = snapshot("retrying", 2);
    expect(getModelDiscoveryToast(value)).toMatchObject({
      type: "info",
      timeout: 0,
      description: expect.stringContaining("2 of 3"),
    });
    expect(getModelDiscoveryToast(value)?.key).toBe(
      getModelDiscoveryToast({ ...value, checkedAt: "2026-10-01T00:00:00.000Z" })?.key,
    );
  });
  it("shows green recovery and amber nonfatal exhaustion", () => {
    expect(getModelDiscoveryToast(snapshot("recovered"))?.type).toBe("success");
    expect(getModelDiscoveryToast(snapshot("exhausted", 3))?.type).toBe("warning");
    expect(getModelDiscoveryToast({ ...snapshot("retrying"), enabled: false })).toBeUndefined();
  });
});
