import type { SessionMessageInfo } from "@opencode/client";
import { boundSubagentText } from "@bigbud/shared/providerSubagents";
import type { V2SubagentContent } from "./Runtime.subagents.map.ts";
import { V2_SUBAGENT_TOOL_NAME } from "./Runtime.subagents.map.ts";

/** Correlate native tool progress metadata, never title/order, to an observed child. */
export function v2SubagentAssignments(
  assistants: readonly SessionMessageInfo[],
  childIds: ReadonlySet<string>,
) {
  type Assignment = Partial<
    Pick<V2SubagentContent, "description" | "prompt" | "background" | "parentToolUseId">
  >;
  const assignments = new Map<string, Assignment>();
  for (let index = assistants.length - 1; index >= 0 && assignments.size < childIds.size; index--) {
    const message = assistants[index]!;
    if (message.type !== "assistant") continue;
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
      const part = message.content[partIndex]!;
      if (
        part.type !== "tool" ||
        part.name !== V2_SUBAGENT_TOOL_NAME ||
        part.state.status === "streaming"
      )
        continue;
      const childId = part.state.metadata?.sessionID;
      if (typeof childId !== "string" || !childIds.has(childId) || assignments.has(childId))
        continue;
      const input = part.state.input;
      const description = boundSubagentText(input.description, "progressSummary");
      const prompt = boundSubagentText(input.prompt, "prompt");
      assignments.set(childId, {
        parentToolUseId: part.id,
        ...(description ? { description } : {}),
        ...(prompt ? { prompt } : {}),
        ...(input.background === undefined || typeof input.background === "boolean"
          ? { background: input.background === true }
          : {}),
      });
    }
  }
  return assignments;
}
