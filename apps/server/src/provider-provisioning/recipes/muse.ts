import { bundledComponent, type ProviderRecipe, userExecutable } from "../recipe.ts";

/** Muse Code: the SDK is inlined and spawns the user's own `muse serve` process. */
export const museRecipe: ProviderRecipe = {
  kind: "muse",
  displayName: "Muse Code",
  provisionedBy: "user",
  components: [
    bundledComponent({
      id: "muse-sdk",
      description: "Muse Code SDK, inlined into the server bundle",
      packages: ["@muse-code/sdk"],
    }),
    userExecutable({
      id: "muse-cli",
      description: "Muse CLI, launched as `muse serve`",
      settingsKey: "providers.muse.binaryPath",
      commandNames: ["muse"],
    }),
  ],
  authReadiness: {
    module: "provider/Layers/Muse/Provider.ts",
    exportName: "checkMuseProviderStatus",
    userStep: "Run `muse` in a terminal and complete browser sign-in",
  },
  manual: {
    vendor: "Meta",
    installCommands: ["See vendor docs (Meta Muse Code) to install the `muse` command"],
    // Same URL as MUSE_INSTALL_GUIDE_URL in provider/Layers/Muse/Provider.ts.
    docsUrl: "https://dev.meta.ai/docs/muse-code",
  },
  notes: [
    "Browser sign-in only; an API key override is reported as a warning by the readiness check.",
    "Meta's install.sh launcher is never run by bigbud.",
  ],
};
