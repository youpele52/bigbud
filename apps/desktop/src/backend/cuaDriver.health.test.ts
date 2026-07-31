import { describe, expect, it } from "vitest";

import { parseCuaDriverHealthReport } from "./cuaDriver.health";

function health(overall: string, failedChecks: readonly string[] = []) {
  return {
    content: [{ type: "text", text: `health ${overall}` }],
    structuredContent: {
      overall,
      checks: failedChecks.map((name) => ({ name, status: "fail" })),
    },
  };
}

describe("parseCuaDriverHealthReport", () => {
  it("accepts an operational report", () => {
    expect(parseCuaDriverHealthReport(health("ok"))).toEqual({
      overall: "ok",
      diagnostics: "health ok",
      failedChecks: [],
      repairRequired: false,
    });
  });

  it("classifies macOS permission-only degradation without requesting runtime repair", () => {
    expect(
      parseCuaDriverHealthReport(
        health("degraded", ["bundle_identity", "tcc_accessibility", "ax_capability"]),
      ),
    ).toMatchObject({
      overall: "degraded",
      repairRequired: false,
    });
  });

  it("requires repair for non-permission degradation and failed health", () => {
    expect(parseCuaDriverHealthReport(health("degraded", ["session_active"]))).toMatchObject({
      repairRequired: true,
    });
    expect(parseCuaDriverHealthReport(health("failed", ["platform_supported"]))).toMatchObject({
      repairRequired: true,
    });
  });

  it("rejects malformed or unknown health reports", () => {
    expect(() => parseCuaDriverHealthReport({})).toThrow("structured content");
    expect(() => parseCuaDriverHealthReport(health("ready"))).toThrow("unsupported overall");
  });
});
