import { describe, expect, it } from "vitest";

import { shouldHandleMobileComposerEnter } from "./MobileComposer.logic";

describe("mobile composer Enter handling", () => {
  it("does not dispatch while an IME composition is active", () => {
    expect(
      shouldHandleMobileComposerEnter({ key: "Enter", shiftKey: false, isComposing: true }),
    ).toBe(false);
  });

  it("keeps ordinary Enter submit and Shift+Enter multiline behavior", () => {
    expect(
      shouldHandleMobileComposerEnter({ key: "Enter", shiftKey: false, isComposing: false }),
    ).toBe(true);
    expect(
      shouldHandleMobileComposerEnter({ key: "Enter", shiftKey: true, isComposing: false }),
    ).toBe(false);
  });
});
