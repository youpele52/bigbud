import { bundledComponent, type ProviderRecipe, userExecutable } from "../recipe.ts";

/** CLIProxyAPI: two user components, a running proxy service and a runnable Claude CLI. */
export const cliProxyRecipe: ProviderRecipe = {
  kind: "cliProxy",
  displayName: "CLIProxyAPI",
  provisionedBy: "user",
  components: [
    bundledComponent({
      id: "cliproxy-claude-harness",
      description: "Shared Claude harness and agent SDK, inlined into the server bundle",
      packages: ["@anthropic-ai/claude-agent-sdk"],
    }),
    userExecutable({
      id: "cliproxyapi-service",
      description: "CLIProxyAPI service binary; configured via providers.cliProxy.configPath",
      settingsKey: null,
      commandNames: ["cliproxyapi", "cli-proxy-api"],
    }),
    userExecutable({
      id: "claude-cli",
      description: "Claude Code CLI shared with the Claude provider",
      settingsKey: "providers.claudeAgent.binaryPath",
      commandNames: ["claude"],
    }),
  ],
  authReadiness: {
    module: "provider/Layers/CliProxy/Provider.ts",
    exportName: "checkCliProxyProvider",
    userStep: "Configure upstream accounts in the CLIProxyAPI config file, then start the service",
  },
  manual: {
    vendor: "router-for-me",
    installCommands: [
      "brew install cliproxyapi",
      "npm install -g @anthropic-ai/claude-code",
      "Without Homebrew: download a release from the docs URL below",
    ],
    docsUrl: "https://github.com/router-for-me/CLIProxyAPI/releases",
  },
  notes: [
    "Auth is local-config only; bigbud never inspects or copies proxy credentials.",
    "bigbud never starts, updates or restarts the proxy service.",
  ],
};
