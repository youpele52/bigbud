import { bundledComponent, type ProviderRecipe, userExecutable } from "../recipe.ts";

/** Cursor: bigbud's ACP client drives the user's own Cursor Agent CLI (`agent acp`). */
export const cursorRecipe: ProviderRecipe = {
  kind: "cursor",
  displayName: "Cursor",
  provisionedBy: "user",
  components: [
    bundledComponent({
      id: "acp-client",
      description: "bigbud ACP adapter and client support, inlined",
      packages: [],
    }),
    userExecutable({
      id: "cursor-agent-cli",
      description: "Cursor Agent CLI, launched as `agent acp`",
      settingsKey: "providers.cursor.binaryPath",
      commandNames: ["agent"],
    }),
  ],
  authReadiness: {
    module: "provider/Layers/Cursor/Provider.ts",
    exportName: "checkCursorProviderStatus",
    userStep: "agent login",
  },
  manual: {
    vendor: "Cursor",
    installCommands: ["See vendor docs (Cursor CLI) to install the `agent` command"],
    docsUrl: "https://cursor.com/docs/cli/acp",
  },
  notes: ["The Cursor CLI's own installer is never run by bigbud."],
};
