import type { ClaudeSettings } from "@bigbud/contracts";

import { buildServerProvider, providerModelsFromSettings } from "../../providerSnapshot";
import {
  BUILT_IN_MODELS,
  DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  dedupeClaudeModels,
} from "./Provider.capabilities";

const PROVIDER = "claudeAgent" as const;

export function makeClaudeInitialSnapshot(claudeSettings: ClaudeSettings) {
  const models = dedupeClaudeModels(
    providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    ),
  );
  const checkedAt = new Date().toISOString();
  const modelDiscovery = {
    status: "unavailable" as const,
    source: "fallback" as const,
    version: "0.3.219",
    durationMs: 0,
  };

  return buildServerProvider({
    provider: PROVIDER,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    modelDiscovery,
    probe: claudeSettings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking Claude availability...",
        }
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in bigbud settings.",
        },
  });
}
