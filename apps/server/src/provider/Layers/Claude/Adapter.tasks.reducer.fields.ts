/**
 * Optional-field merging for the Claude task reducer. Each field takes the record's value
 * when present and otherwise keeps the existing task's value.
 *
 * Record keys follow the SDK wire names (`task_type`, `run_id`, ...) plus the internal keys the
 * adapter uses for subagent data (`requested_model`, `observed_model`, `recent_steps`, ...).
 *
 * @module ClaudeAdapter.tasks.reducer.fields
 */
import {
  boundSubagentText,
  normalizeSubagentMetrics,
  type ProviderSubagentStep,
} from "@bigbud/shared/providerSubagents";

import { asRecord, fieldString, stringValue, stringValues } from "./Adapter.tasks.reducer.parse.ts";
import type { ClaudeTask } from "./Adapter.tasks.types.ts";

type Fields = Partial<ClaudeTask>;

function keep<K extends keyof ClaudeTask>(
  key: K,
  incoming: ClaudeTask[K] | undefined,
  existing: ClaudeTask | undefined,
): Fields {
  const value = incoming ?? existing?.[key];
  return value === undefined ? {} : ({ [key]: value } as Fields);
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? (record[key] as boolean) : undefined;
}

function depthField(record: Record<string, unknown>): number | undefined {
  const value = record.spawn_depth ?? record.depth;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function endTimeField(record: Record<string, unknown>): string | undefined {
  const endTime = record.end_time;
  if (typeof endTime === "number" && Number.isFinite(endTime) && endTime > 0) {
    return new Date(endTime).toISOString();
  }
  return fieldString(record, "ended_at", "endedAt");
}

function stepsField(
  record: Record<string, unknown>,
): ReadonlyArray<ProviderSubagentStep> | undefined {
  return Array.isArray(record.recent_steps)
    ? (record.recent_steps as ReadonlyArray<ProviderSubagentStep>)
    : undefined;
}

/** Fields that existed before SDK 0.3.301 adoption; `task_type` no longer feeds `subagentType`. */
export function legacyTaskFields(
  record: Record<string, unknown>,
  existing: ClaudeTask | undefined,
): Fields {
  return {
    ...keep("description", stringValue(record.description), existing),
    ...keep(
      "activeLabel",
      fieldString(record, "active_form", "activeForm", "activeLabel"),
      existing,
    ),
    ...keep("requestId", fieldString(record, "request_id", "requestId"), existing),
    ...keep("agentId", fieldString(record, "agent_id", "agentId"), existing),
    ...keep("parentAgentId", fieldString(record, "parent_agent_id", "parentAgentId"), existing),
    ...keep(
      "parentToolUseId",
      fieldString(record, "parent_tool_use_id", "parentToolUseId"),
      existing,
    ),
    ...keep("parentTaskId", fieldString(record, "parent_task_id", "parentTaskId"), existing),
    ...keep("subagentType", fieldString(record, "subagent_type", "subagentType"), existing),
    ...keep("blocks", stringValues(record.blocks), existing),
    ...keep(
      "blockedBy",
      stringValues(record.blockedBy) ?? stringValues(record.blocked_by),
      existing,
    ),
    ...keep(
      "progressSummary",
      fieldString(record, "progress_summary", "progressSummary", "summary"),
      existing,
    ),
    ...keep("lastToolName", fieldString(record, "last_tool_name", "lastToolName"), existing),
    ...(record.usage !== undefined
      ? { usage: record.usage }
      : existing?.usage !== undefined
        ? { usage: existing.usage }
        : {}),
    ...keep(
      "terminalReason",
      fieldString(record, "terminal_reason", "terminalReason", "error"),
      existing,
    ),
  };
}

/** Provider-subagent fields added for SDK 0.3.301. */
export function subagentTaskFields(
  record: Record<string, unknown>,
  existing: ClaudeTask | undefined,
): Fields {
  const metrics = normalizeSubagentMetrics(asRecord(record.metrics) ?? {}, existing?.metrics);
  return {
    ...keep("taskType", fieldString(record, "task_type", "taskType"), existing),
    ...keep("ambient", booleanField(record, "ambient"), existing),
    ...keep("runId", fieldString(record, "run_id", "runId"), existing),
    ...keep("prompt", boundSubagentText(record.prompt, "prompt"), existing),
    ...keep("requestedModel", boundSubagentText(record.requested_model, "model"), existing),
    // The first model a subagent reports is kept; later messages cannot rewrite it.
    ...keep(
      "observedModel",
      existing?.observedModel ?? boundSubagentText(record.observed_model, "model"),
      undefined,
    ),
    ...keep("resolvedModel", boundSubagentText(record.resolved_model, "model"), existing),
    ...keep("effort", boundSubagentText(record.effort, "effort"), existing),
    ...keep("depth", depthField(record), existing),
    ...keep("background", booleanField(record, "is_backgrounded"), existing),
    ...keep("endedAt", endTimeField(record), existing),
    ...keep("resultSummary", boundSubagentText(record.result_summary, "resultSummary"), existing),
    ...(metrics ? { metrics } : {}),
    ...keep("recentSteps", stepsField(record), existing),
  };
}

/**
 * Orders a frame against the task's current run. A frame from an older run is late and
 * ignored; a frame from a newer run reopens a terminal task.
 */
export function runTransition(
  record: Record<string, unknown>,
  existing: ClaudeTask | undefined,
): "late" | "newer" | "same" {
  const incoming = fieldString(record, "run_id", "runId");
  if (!incoming || !existing?.runId || incoming === existing.runId) return "same";
  return incoming < existing.runId ? "late" : "newer";
}

/** Drops the previous run's end time, result and failure reason. */
export function withoutRunResult(task: ClaudeTask): ClaudeTask {
  const { endedAt: _endedAt, resultSummary: _result, terminalReason: _reason, ...rest } = task;
  return rest;
}
