import type { CodexSettings } from "@bigbud/contracts";

import { buildServerProvider } from "../../providerSnapshot";
import { getCodexFallbackModels } from "./Provider.models";

const PROVIDER = "codex" as const;

export function makeCodexInitialSnapshot(codexSettings: CodexSettings) {
  const models = getCodexFallbackModels(codexSettings.customModels);
  const checkedAt = new Date().toISOString();

  return buildServerProvider({
    provider: PROVIDER,
    enabled: codexSettings.enabled,
    checkedAt,
    models,
    probe: codexSettings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking Codex availability...",
        }
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Codex is disabled in bigbud settings.",
        },
  });
}
