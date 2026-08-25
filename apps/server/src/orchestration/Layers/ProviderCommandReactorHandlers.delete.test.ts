import { describe, expect, it } from "vitest";

import { resolveDeletionRequestMode } from "./ProviderCommandReactorHandlers.delete.ts";

describe("resolveDeletionRequestMode", () => {
  it("preserves subtree behavior for legacy mode-less events", () => {
    expect(resolveDeletionRequestMode(undefined)).toBe("subtree");
  });
});
