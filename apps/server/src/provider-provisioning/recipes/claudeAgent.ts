import { bundledComponent, type ProviderRecipe, userExecutable } from "../recipe.ts";

/** Claude: the agent SDK is inlined; it drives the user's own Claude Code executable. */
export const claudeAgentRecipe: ProviderRecipe = {
  kind: "claudeAgent",
  displayName: "Claude",
  provisionedBy: "user",
  components: [
    bundledComponent({
      id: "claude-agent-sdk",
      description: "Claude agent SDK, inlined into the server bundle",
      packages: ["@anthropic-ai/claude-agent-sdk"],
    }),
    userExecutable({
      id: "claude-cli",
      description: "Claude Code CLI passed to the SDK as pathToClaudeCodeExecutable",
      settingsKey: "providers.claudeAgent.binaryPath",
      commandNames: ["claude"],
    }),
  ],
  authReadiness: {
    module: "provider/Layers/Claude/Provider.ts",
    exportName: "checkClaudeProviderStatus",
    userStep: "claude auth login",
  },
  manual: {
    vendor: "Anthropic",
    installCommands: ["npm install -g @anthropic-ai/claude-code"],
    docsUrl: "https://code.claude.com/docs/en/agent-sdk",
  },
  notes: ["Credentials stay in the user's Claude configuration; bigbud never copies them."],
};
