import { ComputerUseDesktopV2Action } from "@bigbud/contracts/orchestration/computerUseDesktopV2";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { groundDesktopV2Action, resolveDelivery } from "./v2.grounding";

const decode = Schema.decodeUnknownSync(ComputerUseDesktopV2Action);
const v2 = (fields: Record<string, unknown>) =>
  decode({ schemaVersion: 2, surface: "desktop", ...fields });
const code = (
  fields: Record<string, unknown>,
  fallback: "foreground" | "background" = "foreground",
) => {
  const grounded = groundDesktopV2Action(v2(fields), fallback);
  return grounded.ok ? "ok" : grounded.code;
};

describe("resolveDelivery", () => {
  it("prefers the explicit request, then the compatibility spelling, then the user default", () => {
    expect(resolveDelivery({}, "background")).toBe("background");
    expect(resolveDelivery({ background: false }, "background")).toBe("foreground");
    expect(resolveDelivery({ background: true }, "foreground")).toBe("background");
    expect(resolveDelivery({ delivery: "foreground" }, "background")).toBe("foreground");
    expect(resolveDelivery({ delivery: "background", background: true }, "foreground")).toBe(
      "background",
    );
  });

  it("refuses disagreeing spellings instead of choosing one", () => {
    expect(resolveDelivery({ delivery: "foreground", background: true }, "foreground")).toBeNull();
    expect(resolveDelivery({ delivery: "background", background: false }, "background")).toBeNull();
  });
});

describe("groundDesktopV2Action", () => {
  const click = { action: "click", observationRef: "obs-1", x: 1, y: 2 };

  it("resolves delivery for input, launch and navigate, and refuses conflicts", () => {
    const grounded = groundDesktopV2Action(v2(click), "background");
    expect(grounded).toEqual({ ok: true, value: { action: v2(click), delivery: "background" } });
    expect(code({ ...click, delivery: "foreground", background: true })).toBe("delivery_conflict");
    const launch = groundDesktopV2Action(v2({ action: "launch_app", name: "Notes" }), "background");
    expect(launch.ok && launch.value.delivery).toBe("background");
    const navigate = groundDesktopV2Action(
      v2({ action: "navigate", url: "https://example.com", background: false }),
      "background",
    );
    expect(navigate.ok && navigate.value.delivery).toBe("foreground");
  });

  it("requires coordinate pairs, matching observations and exact targets for scroll", () => {
    const scroll = { action: "scroll", deltaY: 120 };
    expect(code({ ...scroll, x: 3 })).toBe("invalid_arguments");
    expect(code({ ...scroll, y: 3, observationRef: "obs-1" })).toBe("invalid_arguments");
    expect(code({ ...scroll, x: 3, y: 4, targetRef: "target-1" })).toBe("observation_missing");
    expect(code({ ...scroll, observationRef: "obs-1" })).toBe("target_missing");
    expect(code({ action: "scroll", targetRef: "target-1" })).toBe("invalid_arguments");
    const grounded = groundDesktopV2Action(
      v2({ ...scroll, deltaX: -500, x: 3, y: 4, observationRef: "obs-1" }),
      "foreground",
    );
    expect(grounded.ok && grounded.value.scroll).toEqual({ direction: "left", amount: 100 });
    const tie = groundDesktopV2Action(
      v2({ action: "scroll", targetRef: "t", deltaX: 7, deltaY: -7 }),
      "foreground",
    );
    expect(tie.ok && tie.value.scroll).toEqual({ direction: "up", amount: 7 });
  });

  it("accepts exactly one focus selector and always focuses in the foreground", () => {
    expect(code({ action: "focus_app" })).toBe("target_missing");
    expect(code({ action: "focus_app", targetRef: "t", name: "Notes" })).toBe("selector_conflict");
    const byName = groundDesktopV2Action(v2({ action: "focus_app", name: "Notes" }), "background");
    expect(byName.ok && byName.value.delivery).toBe("foreground");
    expect(code({ action: "focus_app", targetRef: "t" })).toBe("ok");
  });

  it("never lets a captureAfter wait reacquire a target", () => {
    expect(code({ action: "wait", durationMs: 10, captureAfter: true })).toBe("target_missing");
    expect(code({ action: "wait", durationMs: 10, captureAfter: true, targetRef: "t" })).toBe("ok");
    expect(code({ action: "wait", durationMs: 10 })).toBe("ok");
  });

  it("leaves read actions without a delivery mode", () => {
    for (const fields of [
      { action: "capture" },
      { action: "list_apps" },
      { action: "get_accessibility_tree", maxDepth: 3 },
      { action: "check_permissions", prompt: false },
    ]) {
      const grounded = groundDesktopV2Action(v2(fields), "background");
      expect(grounded.ok && grounded.value.delivery).toBeUndefined();
    }
  });

  it("still rejects raw PID/window selectors at decode time", () => {
    expect(() => v2({ ...click, pid: 42 })).toThrow();
    expect(() => v2({ action: "focus_app", name: "Notes", windowId: 7 })).toThrow();
  });
});
