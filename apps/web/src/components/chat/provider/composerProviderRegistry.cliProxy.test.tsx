import type { ServerProviderModel } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { getComposerProviderState } from "./composerProviderRegistry";

const CLI_PROXY_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5-codex",
    name: "GPT-5 Codex",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

describe("CLIProxyAPI composer provider state", () => {
  it("keeps CLIProxyAPI provider state isolated from Codex and Copilot options", () => {
    expect(
      getComposerProviderState({
        provider: "cliProxy",
        model: "gpt-5-codex",
        models: CLI_PROXY_MODELS,
        prompt: "",
        modelOptions: { copilot: { reasoningEffort: "high" } },
      }),
    ).toEqual({
      provider: "cliProxy",
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    });
  });
});
