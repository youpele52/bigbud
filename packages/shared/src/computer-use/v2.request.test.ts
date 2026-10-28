import { describe, expect, it } from "vitest";

import { classifyDesktopV2Request } from "./v2.request";

const v2 = { schemaVersion: 2, surface: "desktop" } as const;
const code = (raw: unknown) => {
  const result = classifyDesktopV2Request(raw);
  return result.kind === "refused" ? result.code : result.kind;
};

describe("classifyDesktopV2Request", () => {
  it("leaves browser requests, including the omitted-surface default, on their schema", () => {
    expect(code({ surface: "browser", action: "click", x: 1, y: 2 })).toBe("browser");
    expect(code({ action: "click", x: 1, y: 2 })).toBe("browser");
    expect(code({ action: "scroll", deltaY: 3 })).toBe("browser");
    expect(code({ surface: "web", action: "click" })).toBe("invalid_arguments");
  });

  it("routes desktop-only actions to desktop whatever surface claims", () => {
    expect(code({ surface: "browser", action: "focus_app", pid: 4 })).toBe("version_required");
    expect(code({ action: "list_apps" })).toBe("version_required");
    expect(code({ schemaVersion: 2, surface: "browser", action: "focus_app", name: "N" })).toBe(
      "invalid_arguments",
    );
  });

  it("refuses legacy ungrounded desktop requests instead of adapting them", () => {
    expect(code({ surface: "desktop", action: "click", x: 1, y: 2, pid: 4 })).toBe(
      "version_required",
    );
    expect(code({ ...v2, schemaVersion: "2", action: "list_apps" })).toBe("version_required");
  });

  it("refuses raw selectors, unknown fields and numeric coercion", () => {
    const click = { ...v2, action: "click", observationRef: "o1", x: 1, y: 2 };
    expect(code({ ...click, pid: 4 })).toBe("selector_conflict");
    expect(code({ ...click, windowId: 7 })).toBe("selector_conflict");
    expect(code({ ...click, extra: true })).toBe("invalid_arguments");
    expect(code({ ...click, x: "1" })).toBe("invalid_arguments");
    expect(code({ ...click, observationRef: "x".repeat(129) })).toBe("invalid_arguments");
    expect(code(null)).toBe("invalid_arguments");
    expect(code([])).toBe("invalid_arguments");
    expect(code(click)).toBe("desktop_v2");
  });
});
