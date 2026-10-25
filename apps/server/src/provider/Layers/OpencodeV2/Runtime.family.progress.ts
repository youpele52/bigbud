import type { SessionMessageInfo } from "@opencode/client";
import { appendSubagentStep, type ProviderSubagentStep } from "@bigbud/shared/providerSubagents";

/** Recent native child steps, bounded independently of the child's retained conversation size. */
export function v2OwnedChildSteps(newestFirst: readonly SessionMessageInfo[]) {
  let recentSteps: readonly ProviderSubagentStep[] = [];
  for (const message of newestFirst.toReversed()) {
    if (message.type !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "tool") continue;
      recentSteps = appendSubagentStep(recentSteps, {
        id: part.id,
        toolName: part.name,
        status:
          part.state.status === "completed"
            ? "completed"
            : part.state.status === "error"
              ? "failed"
              : "running",
        at: new Date(message.time.completed ?? message.time.created).toISOString(),
      });
    }
  }
  return recentSteps;
}
