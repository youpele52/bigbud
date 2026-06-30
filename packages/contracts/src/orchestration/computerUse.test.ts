import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ComputerUseAction } from "./computerUse";

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
});
