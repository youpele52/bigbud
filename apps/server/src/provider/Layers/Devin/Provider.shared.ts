import type { DevinSettings, ModelCapabilities, ServerProviderModel } from "@bigbud/contracts";

import { providerModelsFromSettings } from "../../providerSnapshot.ts";

export const PROVIDER = "devin" as const;
export const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

export const DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
export const DEVIN_ACP_MODEL_CAPABILITY_TIMEOUT = "4 seconds";
export const DEVIN_ACP_MODEL_DISCOVERY_CONCURRENCY = 4;
export const DEVIN_REFRESH_INTERVAL = "1 hour";

export interface DevinSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

export interface DevinAcpDiscoveredModel {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
}

export function getDevinFallbackModels(
  devinSettings: Pick<DevinSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], PROVIDER, devinSettings.customModels, EMPTY_CAPABILITIES);
}
