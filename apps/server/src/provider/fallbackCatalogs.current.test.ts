import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { describe, expect, it } from "vitest";
import { getCodexFallbackModels } from "./Layers/Codex/Provider.models";
import { BUILT_IN_MODELS as claudeModels } from "./Layers/Claude/Provider.capabilities";
import { makeCopilotInitialSnapshot } from "./Layers/Copilot/Provider";
import { getCursorFallbackModels } from "./Layers/Cursor/Provider.shared";
import { getDevinFallbackModels } from "./Layers/Devin/Provider.shared";
import { managedServerBuiltInModels } from "./managedServerCatalogFallback";

describe("fallback catalogs verified 2026-09-30", () => {
  it("includes the current Codex source catalog without inventing verified capabilities", () => {
    const models = getCodexFallbackModels([]);
    expect(models.map(({ slug }) => slug)).toEqual(
      expect.arrayContaining([
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
      ]),
    );
    expect(
      models.find(({ slug }) => slug === "gpt-6-astra")?.capabilities?.reasoningEffortLevels,
    ).toEqual([]);
  });
  it("uses provider-specific Claude and Copilot IDs", () => {
    expect(claudeModels.map(({ slug }) => slug)).toEqual(
      expect.arrayContaining(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]),
    );
    const copilot = makeCopilotInitialSnapshot(DEFAULT_UNIFIED_SETTINGS.providers.copilot);
    expect(copilot.models.map(({ slug }) => slug)).toEqual(
      expect.arrayContaining([
        "claude-sonnet-5.5",
        "claude-opus-5.5",
        "gpt-6.1-sol",
        "gemini-3.8-flash",
      ]),
    );
  });
  it("retains independent gateway routing IDs", () => {
    expect(managedServerBuiltInModels("opencode")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "claude-sonnet-5-5", subProviderID: "opencode" }),
      ]),
    );
    expect(managedServerBuiltInModels("kilocode")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "anthropic/claude-sonnet-5.5", subProviderID: "kilo" }),
      ]),
    );
  });
  it("does not invent a bundled catalog for custom-only ACP providers", () => {
    expect(getCursorFallbackModels({ customModels: [] })).toEqual([]);
    expect(getDevinFallbackModels({ customModels: [] })).toEqual([]);
  });
});
