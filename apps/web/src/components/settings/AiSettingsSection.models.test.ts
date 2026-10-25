import { describe, expect, it } from "vitest";
import { visibleProviderOptionsForPicker } from "../chat/provider/ProviderModelPicker.models";
import {
  FULL_TEXT_GENERATION_PROVIDERS,
  INTERNAL_TEXT_GENERATION_OPERATIONS,
  supportsInternalTextGeneration,
} from "@bigbud/shared/internalTextGeneration";
import {
  selectTextGenerationModel,
  updateTextGenerationModelOptions,
} from "./AiSettingsSection.models";

describe("operation-aware internal-generation model selection", () => {
  it("offers only full implementations for a global six-operation override", () => {
    const visible = visibleProviderOptionsForPicker(undefined, [], FULL_TEXT_GENERATION_PROVIDERS);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every(({ value }) => FULL_TEXT_GENERATION_PROVIDERS.includes(value))).toBe(true);
    expect(FULL_TEXT_GENERATION_PROVIDERS).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "opencodeV2",
    ]);
    for (const operation of INTERNAL_TEXT_GENERATION_OPERATIONS) {
      expect(supportsInternalTextGeneration("opencodeV2", operation)).toBe(true);
      expect(supportsInternalTextGeneration("opencode", operation)).toBe(false);
    }
    expect(supportsInternalTextGeneration("copilot", "generateThreadTitle")).toBe(true);
    expect(supportsInternalTextGeneration("copilot", "generateCommitMessage")).toBe(false);
  });
  it("persists distinct native accounts with identical model IDs and retains them when changing variants", () => {
    const a = selectTextGenerationModel("opencodeV2", "same-native-id", "account-a");
    const b = selectTextGenerationModel("opencodeV2", "same-native-id", "account-b");
    expect(a).not.toEqual(b);
    expect(updateTextGenerationModelOptions(b, { variant: "deep" })).toEqual({
      provider: "opencodeV2",
      model: "same-native-id",
      subProviderID: "account-b",
      options: { variant: "deep" },
    });
    expect(updateTextGenerationModelOptions(b, undefined)).toMatchObject({
      subProviderID: "account-b",
    });
  });
});
