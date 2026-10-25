/**
 * Classification and model resolution for Claude native tasks.
 *
 * Only agent task types become provider subagents. Shell, workflow, MCP and monitor tasks,
 * ambient housekeeping tasks and every task of an unsupported harness (CLIProxy) stay ordinary
 * tasks.
 *
 * @module ClaudeAdapter.tasks.classify
 */
import type { ClaudeTask } from "./Adapter.tasks.types.ts";

/** `local_agent` and `remote_agent` from CLI 2.1.x; `agent` from older synthetic frames. */
export const CLAUDE_SUBAGENT_TASK_TYPES: ReadonlySet<string> = new Set([
  "local_agent",
  "remote_agent",
  "agent",
]);

export interface ClaudeTaskClassificationOptions {
  readonly providerSubagentsSupported: boolean;
  /** `AgentInfo.model` by agent type, from `initializationResult()`. */
  readonly agentModels?: ReadonlyMap<string, string> | undefined;
}

export function isClaudeProviderSubagent(
  task: Pick<ClaudeTask, "taskType" | "ambient">,
  providerSubagentsSupported: boolean,
): boolean {
  const taskType = task.taskType?.trim();
  return (
    providerSubagentsSupported &&
    task.ambient !== true &&
    taskType !== undefined &&
    CLAUDE_SUBAGENT_TASK_TYPES.has(taskType)
  );
}

/**
 * Model order: the Agent tool input, the agent definition (unless `inherit`), the first
 * model the subagent reported, then `AgentOutput.resolvedModel`. Unknown stays absent.
 */
export function resolveClaudeSubagentModel(
  task: ClaudeTask,
  agentModels: ReadonlyMap<string, string> | undefined,
): string | undefined {
  const defined = task.subagentType ? agentModels?.get(task.subagentType) : undefined;
  return (
    task.requestedModel ??
    (defined && defined !== "inherit" ? defined : undefined) ??
    task.observedModel ??
    task.resolvedModel
  );
}
