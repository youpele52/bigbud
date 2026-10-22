/**
 * Where a projected `thread.prompt-queued` lands. Shared by the server projectors and the web
 * store so the queue order they show always agrees.
 *
 * @module queuedPromptOrder
 */
import type { OrchestrationQueuedPrompt } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

/**
 * Ordinary prompts append. A busy-refused message re-queued as already sent uses the position
 * the server decided, ahead of prompts queued after it. Older events without a position append.
 */
export function insertQueuedPrompt(
  prompts: ReadonlyArray<OrchestrationQueuedPrompt>,
  prompt: OrchestrationQueuedPrompt,
  queuePosition: number | undefined,
): OrchestrationQueuedPrompt[] {
  if (prompt.alreadySent !== true || queuePosition === undefined) return [...prompts, prompt];
  const index = Math.min(Math.max(queuePosition - 1, 0), prompts.length);
  return [...prompts.slice(0, index), prompt, ...prompts.slice(index)];
}
