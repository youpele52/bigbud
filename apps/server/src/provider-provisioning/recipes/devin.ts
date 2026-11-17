import { bundledComponent, type ProviderRecipe, userExecutable } from "../recipe.ts";

/** Devin: bigbud's ACP client drives the user's own Devin CLI (`devin acp`). */
export const devinRecipe: ProviderRecipe = {
  kind: "devin",
  displayName: "Devin",
  provisionedBy: "user",
  components: [
    bundledComponent({
      id: "acp-client",
      description: "bigbud ACP adapter and client support, inlined",
      packages: [],
    }),
    userExecutable({
      id: "devin-cli",
      description: "Devin CLI, launched as `devin acp`",
      settingsKey: "providers.devin.binaryPath",
      commandNames: ["devin"],
    }),
  ],
  authReadiness: {
    module: "provider/Layers/Devin/Provider.ts",
    exportName: "checkDevinProviderStatus",
    userStep: "devin login",
  },
  manual: {
    vendor: "Cognition (Devin)",
    installCommands: ["See vendor docs (Cognition Devin CLI) to install the `devin` command"],
  },
  notes: ["No Devin download URL is recorded in bigbud; use the vendor's documentation."],
};
