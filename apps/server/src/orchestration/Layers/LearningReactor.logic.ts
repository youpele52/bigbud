import type { ModelSelection, ProviderKind } from "@bigbud/contracts";

export function resolveLearningModelSelection(input: {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly selected: ModelSelection;
}): ModelSelection {
  if (input.selected.provider === input.provider) {
    return { ...input.selected, model: input.model };
  }
  switch (input.provider) {
    case "codex":
      return { provider: "codex", model: input.model };
    case "claudeAgent":
      return { provider: "claudeAgent", model: input.model };
    case "copilot":
      return { provider: "copilot", model: input.model };
    case "kilocode":
      return { provider: "kilocode", model: input.model };
    case "opencode":
      return { provider: "opencode", model: input.model };
    case "pi":
      return { provider: "pi", model: input.model };
    case "cursor":
      return { provider: "cursor", model: input.model };
    case "devin":
      return { provider: "devin", model: input.model };
  }
}
