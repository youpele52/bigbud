import { bundledComponent, type ProviderRecipe, userExecutable } from "../recipe.ts";

/** Codex: bigbud speaks the app-server protocol to the user's own `codex` CLI. */
export const codexRecipe: ProviderRecipe = {
  kind: "codex",
  displayName: "Codex",
  provisionedBy: "user",
  components: [
    bundledComponent({
      id: "codex-adapter",
      description: "bigbud Codex app-server protocol adapter (no vendor code)",
      packages: [],
    }),
    userExecutable({
      id: "codex-cli",
      description: "Codex CLI, launched as `codex app-server`",
      settingsKey: "providers.codex.binaryPath",
      commandNames: ["codex"],
    }),
  ],
  authReadiness: {
    module: "provider/Layers/Codex/Provider.ts",
    exportName: "checkCodexProviderStatus",
    userStep: "codex login",
  },
  manual: {
    vendor: "OpenAI",
    installCommands: ["npm install -g @openai/codex"],
  },
  notes: ["No Codex vendor executable is pinned; the user's install decides version and platform."],
};
