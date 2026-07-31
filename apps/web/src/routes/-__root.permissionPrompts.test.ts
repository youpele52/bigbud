import { describe, expect, it } from "vitest";
import { shouldShowFileAccessPrompt } from "./-__root.permissionPrompts";

describe("__root permission prompt gating", () => {
  it("blocks the file-access prompt until server config has loaded", () => {
    expect(
      shouldShowFileAccessPrompt({
        bootstrapComplete: true,
        hasLoadedServerConfig: false,
        hasSeenFileAccessPrompt: false,
      }),
    ).toBe(false);
  });

  it("allows the file-access prompt after bootstrap with loaded config", () => {
    expect(
      shouldShowFileAccessPrompt({
        bootstrapComplete: true,
        hasLoadedServerConfig: true,
        hasSeenFileAccessPrompt: false,
      }),
    ).toBe(true);
  });
});
