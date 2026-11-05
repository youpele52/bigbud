import { describe, expect, it } from "vitest";

import { isRecentFileSave, SAVED_CONFIRMATION_MS } from "./FilePreview.editActions.logic";

describe("file save confirmation", () => {
  it("only stays highlighted for 25 seconds after an acknowledged save", () => {
    const savedAt = 1_000;
    expect(isRecentFileSave(null, savedAt)).toBe(false);
    expect(isRecentFileSave(savedAt, savedAt + SAVED_CONFIRMATION_MS - 1)).toBe(true);
    expect(isRecentFileSave(savedAt, savedAt + SAVED_CONFIRMATION_MS)).toBe(false);
  });
});
