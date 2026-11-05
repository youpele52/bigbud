import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ComputerUseAction } from "./computerUse";
import {
  COMPUTER_USE_REF_MAX_CHARS,
  ComputerUseDesktopV2Action,
  ComputerUseDesktopV2Result,
  ComputerUseV2ErrorCodes,
} from "./computerUseDesktopV2";

const decode = Schema.decodeUnknownSync(ComputerUseDesktopV2Action);
const accepts = (input: unknown) => {
  try {
    decode(input);
    return true;
  } catch {
    return false;
  }
};
const v2 = { schemaVersion: 2, surface: "desktop" } as const;

describe("ComputerUseDesktopV2Action", () => {
  it("decodes grounded mutations and reference-only reads", () => {
    expect(
      decode({ ...v2, action: "click", observationRef: "obs-1", x: 0, y: 12.5, button: "left" }),
    ).toMatchObject({ action: "click", observationRef: "obs-1" });
    expect(accepts({ ...v2, action: "capture" })).toBe(true);
    expect(accepts({ ...v2, action: "type", targetRef: "t-1", text: "hi" })).toBe(true);
    expect(accepts({ ...v2, action: "launch_app", name: "Notes", background: true })).toBe(true);
  });

  it("refuses raw selectors, missing grounding, legacy shape and coercion", () => {
    expect(accepts({ ...v2, action: "click", x: 1, y: 2 })).toBe(false);
    expect(accepts({ ...v2, action: "click", observationRef: "o", x: -1, y: 2 })).toBe(false);
    expect(accepts({ ...v2, action: "click", observationRef: "o", x: "1", y: 2 })).toBe(false);
    expect(accepts({ ...v2, action: "click", observationRef: "o", x: Infinity, y: 2 })).toBe(false);
    expect(accepts({ ...v2, action: "type", text: "missing target" })).toBe(false);
    expect(accepts({ ...v2, action: "focus_app", pid: 42 })).toBe(false);
    expect(accepts({ ...v2, action: "get_accessibility_tree", windowId: 7 })).toBe(false);
    expect(accepts({ action: "click", x: 1, y: 2 })).toBe(false);
    expect(accepts({ ...v2, surface: "browser", action: "capture" })).toBe(false);
    expect(accepts({ ...v2, action: "check_permissions", prompt: true })).toBe(false);
    const long = "r".repeat(COMPUTER_USE_REF_MAX_CHARS + 1);
    expect(accepts({ ...v2, action: "type", targetRef: long, text: "x" })).toBe(false);
  });

  it("keeps the legacy union and browser actions unchanged", () => {
    const legacy = Schema.decodeUnknownSync(ComputerUseAction);
    expect(legacy({ action: "click", x: 1, y: 2, surface: "browser" })).toEqual({
      action: "click",
      x: 1,
      y: 2,
      surface: "browser",
    });
  });

  it("freezes completion and safe error codes in results", () => {
    const result = Schema.decodeUnknownSync(ComputerUseDesktopV2Result)({
      ...v2,
      operationId: "op-1",
      action: "scroll",
      executionStatus: "failed",
      completion: "unknown",
      partial: { delivered: 1, requested: 3 },
      errorCode: "deadline_exceeded",
      summary: "Scroll interrupted",
    });
    expect(result.completion).toBe("unknown");
    expect(ComputerUseV2ErrorCodes).toHaveLength(23);
    expect(() =>
      Schema.decodeUnknownSync(ComputerUseDesktopV2Result)({
        ...v2,
        operationId: "op-1",
        action: "click",
        executionStatus: "succeeded",
        completion: "done",
        summary: "x",
      }),
    ).toThrow();
  });

  it("is closed: unknown keys, snake_case selectors and typos never decode", () => {
    const click = { ...v2, action: "click", observationRef: "o", x: 1, y: 2 };
    expect(accepts(click)).toBe(true);
    expect(accepts({ ...click, window_id: 7 })).toBe(false);
    expect(accepts({ ...click, backgound: true })).toBe(false);
    expect(accepts({ ...v2, action: "list_apps", extra: 1 })).toBe(false);
    const result = {
      ...v2,
      operationId: "op-1",
      action: "scroll",
      executionStatus: "failed",
      summary: "x",
    };
    const decodeResult = Schema.decodeUnknownSync(ComputerUseDesktopV2Result);
    expect(() =>
      decodeResult({ ...result, completion: "unknown", partial: { delivered: 4, requested: 3 } }),
    ).toThrow();
    expect(() => decodeResult({ ...result, completion: "completed", refused: true })).toThrow();
    expect(() =>
      decodeResult({ ...result, completion: "not_started", refused: true }),
    ).not.toThrow();
    expect(() => decodeResult({ ...result, completion: "unknown", leaked: "x" })).toThrow();
    expect(() =>
      decodeResult({
        ...result,
        completion: "unknown",
        partial: { delivered: 1, requested: 2, extra: 1 },
      }),
    ).toThrow();
  });
});
