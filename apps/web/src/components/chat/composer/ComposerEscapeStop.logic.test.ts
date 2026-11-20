import { describe, expect, it } from "vitest";

import {
  classifyEscapeStopKey,
  ESCAPE_STOP_WINDOW_MS,
  resolveEscapeStopPress,
} from "./ComposerEscapeStop.logic";

const key = (overrides: Partial<Parameters<typeof classifyEscapeStopKey>[0]> = {}) => ({
  key: "Escape",
  keyCode: 27,
  repeat: false,
  isComposing: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe("classifyEscapeStopKey", () => {
  it("counts a bare Escape", () => {
    expect(classifyEscapeStopKey(key())).toBe("escape");
  });

  it("ignores auto-repeat", () => {
    expect(classifyEscapeStopKey(key({ repeat: true }))).toBe("ignore");
  });

  it("treats IME, modified Escapes and other keys as disarming", () => {
    expect(classifyEscapeStopKey(key({ isComposing: true }))).toBe("other");
    expect(classifyEscapeStopKey(key({ keyCode: 229 }))).toBe("other");
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(classifyEscapeStopKey(key({ [modifier]: true }))).toBe("other");
    }
    expect(classifyEscapeStopKey(key({ key: "a" }))).toBe("other");
  });
});

describe("resolveEscapeStopPress", () => {
  const press = (armedAt: number | null, now: number, lastResetAt: number | null = null) =>
    resolveEscapeStopPress({ armedAt, lastResetAt, now });

  it("arms on the first press", () => {
    expect(press(null, 1_000)).toBe("arm");
  });

  it("stops on a second press inside the window, including its boundary", () => {
    expect(press(1_000, 1_200)).toBe("stop");
    expect(press(1_000, 1_000 + ESCAPE_STOP_WINDOW_MS)).toBe("stop");
  });

  it("re-arms when the window has passed or time runs backwards", () => {
    expect(press(1_000, 1_001 + ESCAPE_STOP_WINDOW_MS)).toBe("arm");
    expect(press(1_000, 999)).toBe("arm");
  });

  it("re-arms when another key or pointer press happened between the two Escapes", () => {
    expect(press(1_000, 1_200, 1_100)).toBe("arm");
  });

  it("ignores resets from before the first press", () => {
    expect(press(1_000, 1_200, 900)).toBe("stop");
  });
});
