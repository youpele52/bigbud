import type { ModelSelection, OrchestrationMessage, ProviderKind } from "@bigbud/contracts";

const MEMORY_REVIEW_USER_MESSAGE_INTERVAL = 15;

export function countFinalizedUserMessages(messages: ReadonlyArray<OrchestrationMessage>): number {
  return messages.filter((message) => message.role === "user" && !message.streaming).length;
}

export function shouldScheduleMemoryReview(input: {
  readonly userMessageCount: number;
  readonly latestMemoryUserMessageCount: number | null;
}): boolean {
  return (
    input.userMessageCount >= MEMORY_REVIEW_USER_MESSAGE_INTERVAL &&
    input.userMessageCount >=
      (input.latestMemoryUserMessageCount ?? 0) + MEMORY_REVIEW_USER_MESSAGE_INTERVAL
  );
}

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
