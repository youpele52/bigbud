import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  COMPUTER_USE_ACCESSIBILITY_MAX_DEPTH,
  COMPUTER_USE_COORDINATE_MAX,
  COMPUTER_USE_TEXT_MAX_CHARS,
  COMPUTER_USE_WAIT_DURATION_MS_MAX,
  ComputerUseAction,
} from "./computerUse";

const decodeComputerUseAction = Schema.decodeUnknownSync(ComputerUseAction);

describe("ComputerUseAction", () => {
  it("decodes browser capture actions", () => {
    const parsed = decodeComputerUseAction({
      action: "capture",
      surface: "browser",
    });

    expect(parsed).toEqual({
      action: "capture",
      surface: "browser",
    });
  });

  it("decodes desktop diagnostic actions", () => {
    const parsed = decodeComputerUseAction({
      action: "check_permissions",
      prompt: true,
    });

    expect(parsed).toEqual({
      action: "check_permissions",
      prompt: true,
    });
  });

  it("decodes mutating actions with captureAfter", () => {
    const parsed = decodeComputerUseAction({
      action: "click",
      x: 10,
      y: 20,
      button: "right",
      surface: "desktop",
      captureAfter: true,
    });

    expect(parsed).toEqual({
      action: "click",
      x: 10,
      y: 20,
      button: "right",
      surface: "desktop",
      captureAfter: true,
    });
  });

  it("rejects invalid action payloads", () => {
    expect(() =>
      decodeComputerUseAction({
        action: "click",
        x: "bad",
        y: 20,
      }),
    ).toThrow();
  });

  it("rejects out-of-range action payloads", () => {
    expect(() =>
      decodeComputerUseAction({
        action: "click",
        x: COMPUTER_USE_COORDINATE_MAX + 1,
        y: 20,
      }),
    ).toThrow();
    expect(() =>
      decodeComputerUseAction({
        action: "type",
        text: "x".repeat(COMPUTER_USE_TEXT_MAX_CHARS + 1),
      }),
    ).toThrow();
    expect(() =>
      decodeComputerUseAction({
        action: "wait",
        durationMs: COMPUTER_USE_WAIT_DURATION_MS_MAX + 1,
      }),
    ).toThrow();
    expect(() =>
      decodeComputerUseAction({
        action: "get_accessibility_tree",
        maxDepth: COMPUTER_USE_ACCESSIBILITY_MAX_DEPTH + 1,
      }),
    ).toThrow();
  });

  it("rejects unsupported navigation schemes", () => {
    expect(() =>
      decodeComputerUseAction({
        action: "navigate",
        url: "file:///etc/passwd",
      }),
    ).toThrow();
  });
});
