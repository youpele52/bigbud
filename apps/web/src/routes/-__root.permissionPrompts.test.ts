import { describe, expect, it } from "vitest";
import {
  shouldChainComputerUsePrompt,
  shouldShowComputerUsePrompt,
  shouldShowFileAccessPrompt,
} from "./-__root.permissionPrompts";

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

  it("blocks the computer-use prompt until server config has loaded", () => {
    expect(
      shouldShowComputerUsePrompt({
        bootstrapComplete: true,
        hasLoadedServerConfig: false,
        hasSeenFileAccessPrompt: true,
        hasSeenComputerUsePrompt: false,
        isDesktop: true,
        showFileAccessDialog: false,
      }),
    ).toBe(false);
  });

  it("shows the computer-use prompt only when the first-run prerequisites are met", () => {
    expect(
      shouldShowComputerUsePrompt({
        bootstrapComplete: true,
        hasLoadedServerConfig: true,
        hasSeenFileAccessPrompt: true,
        hasSeenComputerUsePrompt: false,
        isDesktop: true,
        showFileAccessDialog: false,
      }),
    ).toBe(true);
  });

  it("does not chain the computer-use prompt after file access when config is still pending", () => {
    expect(
      shouldChainComputerUsePrompt({
        hasLoadedServerConfig: false,
        hasSeenComputerUsePrompt: false,
        isDesktop: true,
      }),
    ).toBe(false);
  });
});
