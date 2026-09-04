import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { CodexModelOptions, CodexReasoningEffort, CopilotModelOptions } from "./model";

describe("Codex reasoning effort", () => {
  it("decodes trimmed dynamic effort values", () => {
    expect(Schema.decodeUnknownSync(CodexReasoningEffort)("  future-depth  ")).toBe("future-depth");
    expect(
      Schema.decodeUnknownSync(CodexModelOptions)({ reasoningEffort: "  future-depth  " }),
    ).toEqual({ reasoningEffort: "future-depth" });
  });

  it("rejects empty effort values", () => {
    expect(() => Schema.decodeUnknownSync(CodexReasoningEffort)("   ")).toThrow();
    expect(() => Schema.decodeUnknownSync(CodexModelOptions)({ reasoningEffort: "   " })).toThrow();
  });

  it("keeps the fixed effort contract for other providers", () => {
    expect(() =>
      Schema.decodeUnknownSync(CopilotModelOptions)({ reasoningEffort: "future-depth" }),
    ).toThrow();
  });
});
