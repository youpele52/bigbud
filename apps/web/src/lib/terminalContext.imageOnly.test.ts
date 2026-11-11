import { applyClaudePromptEffortPrefix } from "@bigbud/shared/model";
import { describe, expect, it } from "vitest";
import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "~/constants/chatPrompt";
import { deriveDisplayedUserMessageState } from "./terminalContext";

describe("image-only message display", () => {
  it("hides the synthetic instruction while preserving the provider prompt", () => {
    const state = deriveDisplayedUserMessageState(IMAGE_ONLY_BOOTSTRAP_PROMPT);
    expect(state.visibleText).toBe("");
    expect(state.copyText).toBe(IMAGE_ONLY_BOOTSTRAP_PROMPT);
  });

  it("hides the synthetic instruction with Claude's injected effort prefix", () => {
    const prompt = applyClaudePromptEffortPrefix(IMAGE_ONLY_BOOTSTRAP_PROMPT, "ultrathink");
    expect(deriveDisplayedUserMessageState(prompt).visibleText).toBe("");
    expect(deriveDisplayedUserMessageState(prompt).copyText).toBe(prompt);
  });

  it("hides the instruction after extracting attachment metadata", () => {
    const prompt = `  ${IMAGE_ONLY_BOOTSTRAP_PROMPT}\n\n<attached_files>\nscreenshot.png\n</attached_files>`;
    expect(deriveDisplayedUserMessageState(prompt).visibleText).toBe("");
  });

  it.each([
    "What does this screenshot mean?",
    `Explain this instruction: ${IMAGE_ONLY_BOOTSTRAP_PROMPT}`,
    `${IMAGE_ONLY_BOOTSTRAP_PROMPT}\nMy caption`,
  ])("keeps user text visible: %s", (prompt) => {
    expect(deriveDisplayedUserMessageState(prompt).visibleText).toBe(prompt);
  });
});
