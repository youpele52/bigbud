import { bundledComponent, type ProviderRecipe, userExecutable } from "../recipe.ts";

/** OpenCode v2: bigbud borrows the user's healthy shared native service and never starts it. */
export const opencodeV2Recipe: ProviderRecipe = {
  kind: "opencodeV2",
  displayName: "OpenCode",
  provisionedBy: "user",
  components: [
    bundledComponent({
      id: "opencode-client",
      description: "OpenCode v2 client, inlined into the server bundle",
      packages: ["@opencode/client", "@opencode-ai/sdk"],
    }),
    userExecutable({
      id: "opencode-shared-service",
      description: "User's OpenCode v2 CLI and its registered shared background service",
      settingsKey: "providers.opencodeV2.binaryPath",
      commandNames: ["opencode"],
    }),
  ],
  authReadiness: {
    module: "provider/Layers/OpencodeV2/SharedService.discovery.ts",
    exportName: "discoverV2SharedService",
    userStep: "Configure a model provider in OpenCode; service lease auth is not model auth",
  },
  manual: {
    vendor: "OpenCode",
    installCommands: ["See vendor docs (OpenCode v2 CLI) to install `opencode`"],
    docsUrl: "https://opencode.ai/v2/docs/cli",
  },
  notes: [
    "Discovery borrows a healthy service only; bigbud never ensures, starts or replaces it.",
    "Development-only provider: preview and version restrictions still apply.",
  ],
};
