import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  CodexModelOptions,
  CodexReasoningEffort,
  CopilotModelOptions,
  CursorModelOptions,
  KilocodeModelOptions,
  OpencodeModelOptions,
} from "./model";

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

  it("keeps the fixed effort contract for Copilot's SDK vocabulary", () => {
    expect(() =>
      Schema.decodeUnknownSync(CopilotModelOptions)({ reasoningEffort: "future-depth" }),
    ).toThrow();
  });

  it("accepts opaque OpenCode, KiloCode, and Cursor effort identifiers", () => {
    expect(Schema.decodeUnknownSync(OpencodeModelOptions)({ reasoningEffort: "  none  " })).toEqual(
      { reasoningEffort: "none" },
    );
    expect(
      Schema.decodeUnknownSync(KilocodeModelOptions)({ reasoningEffort: "custom-xhigh" }),
    ).toEqual({ reasoningEffort: "custom-xhigh" });
    expect(Schema.decodeUnknownSync(CursorModelOptions)({ reasoning: "max" })).toEqual({
      reasoning: "max",
    });
  });
});
