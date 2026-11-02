import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { CopilotRuntimeInput, CopilotRuntimeJob } from "./copilotRuntime";

describe("Copilot lifecycle contracts", () => {
  it("does not accept client release metadata or executable paths as installation authority", () => {
    expect(
      Schema.decodeUnknownSync(CopilotRuntimeInput)({
        action: "install",
        version: "malicious",
        url: "https://evil.example/runtime",
        path: "/external/copilot",
      }),
    ).toEqual({ action: "install" });
  });
  it("rejects implicit or unknown lifecycle actions", () => {
    for (const input of [{}, { action: "auto-install" }, { action: "delete-external" }])
      expect(() => Schema.decodeUnknownSync(CopilotRuntimeInput)(input)).toThrow();
  });
  it("keeps operation identity and phase explicit for reliable retry presentation", () => {
    const job = {
      id: "job",
      operation: "uninstall",
      phase: "error",
      version: "1.0.103",
      transferredBytes: 0,
      totalBytes: 0,
      error: "Stop sessions first",
    };
    expect(Schema.decodeUnknownSync(CopilotRuntimeJob)(job)).toEqual(job);
    expect(() =>
      Schema.decodeUnknownSync(CopilotRuntimeJob)({ ...job, phase: "unknown" }),
    ).toThrow();
  });
});
