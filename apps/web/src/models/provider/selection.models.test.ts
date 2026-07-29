import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import type { ProviderKind, ServerProvider } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { getAppModelOptions, resolveAppModelSelection } from "./selection.models";

function provider(kind: ProviderKind, models: ServerProvider["models"]): ServerProvider {
  return {
    provider: kind,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-29T00:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
  };
}

describe("provider model selection", () => {
  it("does not synthesize stale CLIProxy catalog entries as custom models", () => {
    const providers = [
      provider("cliProxy", [
        {
          slug: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          isCustom: false,
          capabilities: null,
        },
      ]),
    ];

    expect(
      getAppModelOptions(DEFAULT_UNIFIED_SETTINGS, providers, "cliProxy", "old-cli-proxy-model"),
    ).toEqual([{ slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", isCustom: false }]);
  });

  it("keeps a stale catalog selection until the user reselects a catalog model", () => {
    const providers = [
      provider("cliProxy", [
        {
          slug: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          isCustom: false,
          capabilities: null,
        },
      ]),
    ];

    expect(
      resolveAppModelSelection(
        "cliProxy",
        DEFAULT_UNIFIED_SETTINGS,
        providers,
        "old-cli-proxy-model",
      ),
    ).toBe("old-cli-proxy-model");
  });

  it("continues to synthesize configured custom models for extensible providers", () => {
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providers: {
        ...DEFAULT_UNIFIED_SETTINGS.providers,
        codex: {
          ...DEFAULT_UNIFIED_SETTINGS.providers.codex,
          customModels: ["my-codex-model"],
        },
      },
    };
    const providers = [
      provider("codex", [
        { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
      ]),
    ];

    expect(getAppModelOptions(settings, providers, "codex").at(-1)).toEqual({
      slug: "my-codex-model",
      name: "my-codex-model",
      isCustom: true,
    });
  });
});
