import type { CursorSettings, ModelCapabilities, ServerProviderModel } from "@bigbud/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import { providerModelsFromSettings } from "../../providerSnapshot.ts";

export const PROVIDER = "cursor" as const;
export const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

export const CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
export const CURSOR_ACP_MODEL_CAPABILITY_TIMEOUT = "4 seconds";
export const CURSOR_ACP_MODEL_DISCOVERY_CONCURRENCY = 4;
export const CURSOR_REFRESH_INTERVAL = "1 hour";
export const CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE = 2026_04_08;
export const CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export interface CursorSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

export interface CursorAcpDiscoveredModel {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
}

export function getCursorFallbackModels(
  cursorSettings: Pick<CursorSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], PROVIDER, cursorSettings.customModels, EMPTY_CAPABILITIES);
}
