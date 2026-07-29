import { DEFAULT_UNIFIED_SETTINGS, type ServerProvider } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { deriveEffectiveComposerModelState } from "./composer.store";

function provider(input: Pick<ServerProvider, "provider" | "models">): ServerProvider {
  return {
    ...input,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    slashCommands: [],
    skills: [],
  };
}

describe("deriveEffectiveComposerModelState", () => {
  it("keeps a stale CLIProxy project model until the catalog is reselected", () => {
    const providers = [
      provider({
        provider: "cliProxy",
        models: [
          {
            slug: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            isCustom: false,
            capabilities: null,
          },
        ],
      }),
    ];

    const result = deriveEffectiveComposerModelState({
      draft: null,
      providers,
      selectedProvider: "cliProxy",
      threadModelSelection: null,
      projectModelSelection: { provider: "cliProxy", model: "removed-cli-proxy-model" },
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(result.selectedModel).toBe("removed-cli-proxy-model");
  });

  it("does not carry a previous provider model across provider fallback", () => {
    const providers = [
      provider({
        provider: "codex",
        models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
      }),
    ];

    const result = deriveEffectiveComposerModelState({
      draft: null,
      providers,
      selectedProvider: "codex",
      threadModelSelection: { provider: "devin", model: "default" },
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(result.selectedModel).toBe("gpt-5.4");
  });
});
