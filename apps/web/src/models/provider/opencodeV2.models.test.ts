import { describe, expect, it } from "vitest";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import {
  getDefaultModelSelection,
  resolveSelectableProvider,
  isProviderEnabled,
} from "./provider.models";
import {
  normalizeModelSelection,
  normalizeProviderModelOptions,
} from "../../stores/composer/normalization.store.models";
import {
  PROVIDER_OPTIONS,
  getProviderDescriptor,
  getVisibleProviderDescriptors,
} from "../../components/chat/provider/providerDescriptors";
import {
  PROVIDER_SETTINGS,
  buildProviderCards,
} from "../../components/settings/ProvidersSettingsSection.logic";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { developmentProviderOptions } from "../../components/chat/provider/ProviderModelPicker.models";
import { getComposerProviderFallback } from "./composerVisibility.models";

const snapshot: ServerProvider = {
  provider: "opencodeV2",
  enabled: true,
  installed: true,
  version: "2.0.19",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "fixture",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("independent V2 preview model/UI boundaries", () => {
  it("offers explicitly marked development selections/settings without becoming the automatic default", () => {
    const development = { ...snapshot, developmentOnly: true };
    expect(isProviderEnabled([development], "opencodeV2")).toBe(true);
    expect(
      developmentProviderOptions([development]).some((option) => option.value === "opencodeV2"),
    ).toBe(true);
    expect(
      buildProviderCards({
        serverProviders: [development],
        settings: DEFAULT_UNIFIED_SETTINGS,
      }).some((card) => card.provider === "opencodeV2"),
    ).toBe(true);
    expect(getDefaultModelSelection([development]).provider).not.toBe("opencodeV2");
    expect(getComposerProviderFallback([development], [])).not.toBe("opencodeV2");
    expect(resolveSelectableProvider([development], null)).not.toBe("opencodeV2");
  });
  it("preserves independent V2 variant/subprovider identity in saved selections", () => {
    const selection = {
      provider: "opencodeV2",
      model: "model",
      subProviderID: "native",
      options: { variant: "high" },
    };
    expect(normalizeModelSelection(selection)).toEqual(selection);
    expect(
      normalizeProviderModelOptions({
        opencodeV2: { variant: " high " },
        opencode: { reasoningEffort: "low" },
      }),
    ).toEqual({
      opencodeV2: { variant: "high" },
      opencode: { reasoningEffort: "low" },
    });
  });
  it("shows settings and picker without a hidden environment flag, preserving default selection", () => {
    expect(getProviderDescriptor("opencodeV2").pickerAvailable).toBe(true);
    expect(
      getVisibleProviderDescriptors([snapshot]).some(
        (descriptor) => descriptor.provider === "opencodeV2",
      ),
    ).toBe(true);
    expect(PROVIDER_SETTINGS.some((descriptor) => descriptor.provider === "opencodeV2")).toBe(true);
    expect(PROVIDER_OPTIONS.some((option) => option.value === "opencodeV2")).toBe(true);
    const cards = buildProviderCards({ serverProviders: [], settings: DEFAULT_UNIFIED_SETTINGS });
    expect(cards.filter((card) => card.provider === "opencodeV2")).toHaveLength(1);
    expect(cards.find((card) => card.provider === "opencodeV2")?.homePathKey).toBe(
      "opencodeV2ProfileRoot",
    );
    expect(getDefaultModelSelection([snapshot]).provider).not.toBe("opencodeV2");
    expect(resolveSelectableProvider([snapshot], null)).not.toBe("opencodeV2");
    expect(resolveSelectableProvider([snapshot], "opencodeV2")).toBe("opencodeV2");
    expect(isProviderEnabled([snapshot], "opencodeV2")).toBe(true);
    expect(isProviderEnabled([], "opencodeV2")).toBe(false);
  });
});
