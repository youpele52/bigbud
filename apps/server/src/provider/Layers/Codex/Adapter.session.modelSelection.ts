import type { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider.ts";

export interface CodexManagerModelSelection {
  readonly model?: string;
  readonly effort?: string;
  readonly serviceTier?: "fast";
}

export function toCodexManagerModelSelection(
  modelSelection: ModelSelection | null | undefined,
): CodexManagerModelSelection {
  if (modelSelection?.provider !== "codex") {
    return {};
  }

  return {
    model: modelSelection.model,
    ...(modelSelection.options?.reasoningEffort !== undefined
      ? { effort: modelSelection.options.reasoningEffort }
      : {}),
    ...(modelSelection.options?.fastMode ? { serviceTier: "fast" as const } : {}),
  };
}
