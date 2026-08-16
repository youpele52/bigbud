import type { Thread } from "~/models/types";

export type MascotAnimation = "celebration" | "thinking" | "thumbs-up" | "typing" | "wave";

const NEGATED_SUCCESS_PATTERN =
  /\b(?:did(?:n't| not)|is(?:n't| not)|not|was(?:n't| not))\s+(?:amazing|awesome|correct|excellent|great|perfect|right|solved|working|the answer)\b/i;

const CELEBRATORY_FEEDBACK_PATTERNS = [
  /\b(?:amazing|awesome|excellent|fantastic|perfect)\b/i,
  /\b(?:good|great|nice)\s+(?:answer|job|work)\b/i,
  /\bwell done\b/i,
  /\b(?:you|it|the model|codex|claude|copilot|opencode) (?:got it|got the answer|nailed it|solved it)\b/i,
  /\bthat(?:'s| is) (?:correct|exactly right|the answer)\b/i,
  /\bthe answer is correct\b/i,
  /\b(?:it|that) worked\b/i,
  /\b(?:problem|issue|bug) solved\b/i,
  /\b(?:brilliant|impressive|love it|thank you|thanks)\b/i,
] as const;

const AGENT_UNCERTAINTY_PATTERNS = [
  /\bi(?:'m| am|’m) (?:not (?:certain|confident|sure)|uncertain|unsure)\b/i,
  /\bi (?:do not|don't|don’t) know\b/i,
  /\bi (?:could|may|might) be wrong\b/i,
  /\b(?:cannot|can't|can’t) be (?:certain|sure)\b/i,
  /\b(?:hard to say|it is unclear|it's unclear|it’s unclear)\b/i,
] as const;

export function isCelebratoryFeedback(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0 || NEGATED_SUCCESS_PATTERN.test(normalized)) return false;
  return CELEBRATORY_FEEDBACK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function expressesAgentUncertainty(text: string): boolean {
  return AGENT_UNCERTAINTY_PATTERNS.some((pattern) => pattern.test(text));
}

export function deriveMascotWorkState(threads: ReadonlyArray<Thread>): {
  animation: MascotAnimation;
  agentUncertain: boolean;
} {
  for (const thread of threads) {
    if (thread.session?.status !== "running" || thread.session.activeTurnId == null) continue;
    for (const message of thread.messages) {
      if (message.role !== "assistant" || !message.streaming) continue;
      if (expressesAgentUncertainty(message.text)) {
        return { animation: "thinking", agentUncertain: true };
      }
    }
  }

  const agentIsWorking = threads.some(
    (thread) =>
      thread.session?.status === "connecting" ||
      (thread.session?.status === "running" && thread.session.activeTurnId != null),
  );
  return {
    animation: agentIsWorking ? "thinking" : "thumbs-up",
    agentUncertain: false,
  };
}

export function deriveMascotWorkAnimation(threads: ReadonlyArray<Thread>): MascotAnimation {
  return deriveMascotWorkState(threads).animation;
}

export function hasAssistantStreamProgress(
  previousThreads: ReadonlyArray<Thread>,
  nextThreads: ReadonlyArray<Thread>,
): boolean {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread]));

  return nextThreads.some((thread) => {
    if (thread.session?.status !== "running" || thread.session.activeTurnId == null) return false;
    const latestAssistantMessage = thread.messages.findLast(
      (message) => message.role === "assistant" && message.streaming,
    );
    if (!latestAssistantMessage || latestAssistantMessage.text.length === 0) return false;
    const previous = previousById.get(thread.id);
    if (!previous) return false;
    const previousMessage = previous.messages.find(
      (message) => message.id === latestAssistantMessage.id,
    );
    return previousMessage?.text !== latestAssistantMessage.text;
  });
}

export function hasNewAgentUncertainty(
  previousThreads: ReadonlyArray<Thread>,
  nextThreads: ReadonlyArray<Thread>,
): boolean {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread]));

  return nextThreads.some((thread) => {
    const previous = previousById.get(thread.id);
    if (!previous) return false;
    const latestAssistantMessage = thread.messages.findLast(
      (message) => message.role === "assistant",
    );
    if (!latestAssistantMessage || !expressesAgentUncertainty(latestAssistantMessage.text)) {
      return false;
    }
    const previousLatestAssistantMessage = previous.messages.findLast(
      (message) => message.role === "assistant",
    );
    return (
      latestAssistantMessage.id !== previousLatestAssistantMessage?.id ||
      latestAssistantMessage.text !== previousLatestAssistantMessage.text
    );
  });
}

export function hasNewCelebratoryFeedback(
  previousThreads: ReadonlyArray<Thread>,
  nextThreads: ReadonlyArray<Thread>,
): boolean {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread]));

  return nextThreads.some((thread) => {
    const previous = previousById.get(thread.id);
    if (!previous) return false;
    const latestUserMessage = thread.messages.findLast((message) => message.role === "user");
    if (!latestUserMessage || !isCelebratoryFeedback(latestUserMessage.text)) return false;
    const previousLatestUserMessage = previous.messages.findLast(
      (message) => message.role === "user",
    );
    return latestUserMessage.id !== previousLatestUserMessage?.id;
  });
}
