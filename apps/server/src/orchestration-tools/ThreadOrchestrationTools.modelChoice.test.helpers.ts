import type { ModelSelection, ServerProvider } from "@bigbud/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";

import type { ModelChoiceContext } from "./ThreadOrchestrationTools.modelChoice.ts";

export const trunk: ModelSelection = {
  provider: "codex",
  model: "gpt-5",
  options: { reasoningEffort: "high" },
};

export function provider(
  kind: ServerProvider["provider"],
  overrides: Partial<ServerProvider> = {},
  models: ReadonlyArray<Partial<ServerProvider["models"][number]> & { slug: string }> = [
    { slug: `${kind}-model`, name: `${kind} model` },
  ],
): ServerProvider {
  return {
    provider: kind,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-15T10:00:00.000Z",
    models: models.map((model) => ({
      name: model.slug,
      isCustom: false,
      capabilities: null,
      ...model,
    })),
    slashCommands: [],
    skills: [],
    ...overrides,
  } as ServerProvider;
}

export function context(overrides: Partial<ModelChoiceContext> = {}): ModelChoiceContext {
  return {
    providers: [
      provider("codex", {}, [
        { slug: "gpt-5", name: "GPT-5" },
        { slug: "gpt-5-mini", name: "GPT-5 mini" },
      ]),
      provider("claudeAgent", {}, [
        { slug: "claude-opus", name: "Claude Opus" },
        { slug: "claude-sonnet", name: "Claude Sonnet" },
        { slug: "claude-locked", name: "Claude Locked", availability: "requires-setup" },
      ]),
    ],
    settings: DEFAULT_SERVER_SETTINGS,
    recent: [],
    target: {},
    hasInteractiveClient: true,
    ...overrides,
  };
}
