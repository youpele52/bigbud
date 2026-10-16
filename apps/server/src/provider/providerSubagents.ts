/**
 * Shared builder for provider-subagent task events.
 *
 * Adapters describe what their provider exposes; this module owns identity, bounds and
 * normalization, so every provider produces the same `task.updated` shape for the
 * provider-agnostic Subagents card. See "Adding subagent support to a provider" in
 * `docs/plans/2026-10-16-claude-agent-sdk-and-subagent-display-plan.md`.
 *
 * @module providerSubagents
 */
import type {
  ProviderKind,
  ProviderRuntimeEvent,
  TaskUpdatedPayload,
  ThreadId,
} from "@bigbud/contracts";
import { RuntimeTaskId } from "@bigbud/contracts/core/baseSchemas";
import {
  PROVIDER_SUBAGENT_RECENT_STEPS_MAX,
  boundSubagentText,
  normalizeSubagentMetrics,
  type ProviderSubagentMetrics,
  type ProviderSubagentStep,
} from "@bigbud/shared/providerSubagents";

type SubagentStatus = TaskUpdatedPayload["status"];
type TaskUpdatedEvent = Extract<ProviderRuntimeEvent, { type: "task.updated" }>;
/** Common runtime event envelope, as built by each adapter's own event-base helper. */
export type ProviderSubagentEventBase = Omit<ProviderRuntimeEvent, "type" | "payload">;

/** Stable task identity: `{provider}:{threadId}:{epoch}:{nativeId}`. */
export function providerSubagentTaskId(
  provider: ProviderKind,
  threadId: ThreadId,
  epoch: number | string,
  nativeId: string,
) {
  return RuntimeTaskId.makeUnsafe(`${provider}:${threadId}:${epoch}:${nativeId}`);
}

export interface ProviderSubagentUpdate {
  readonly taskId: TaskUpdatedPayload["taskId"];
  readonly nativeId: string;
  readonly status: SubagentStatus;
  /** Defaults to `status === "inProgress"`. */
  readonly activityFresh?: boolean | undefined;
  readonly subject?: unknown;
  readonly description?: unknown;
  readonly subagentType?: unknown;
  readonly agentId?: unknown;
  readonly parentAgentId?: unknown;
  readonly parentToolUseId?: unknown;
  readonly parentTaskId?: TaskUpdatedPayload["parentTaskId"] | undefined;
  readonly activeLabel?: unknown;
  readonly background?: boolean | undefined;
  readonly model?: unknown;
  readonly effort?: unknown;
  readonly prompt?: unknown;
  readonly depth?: number | undefined;
  readonly progressSummary?: unknown;
  readonly resultSummary?: unknown;
  readonly lastToolName?: unknown;
  readonly terminalReason?: unknown;
  readonly endedAt?: string | undefined;
  readonly metrics?:
    | {
        readonly totalTokens?: unknown;
        readonly toolUses?: unknown;
        readonly durationMs?: unknown;
        readonly costUsd?: unknown;
      }
    | undefined;
  readonly previousMetrics?: ProviderSubagentMetrics | undefined;
  readonly recentSteps?:
    | ReadonlyArray<ProviderSubagentStep>
    | TaskUpdatedPayload["recentSteps"]
    | undefined;
  readonly usage?: unknown;
  readonly source: TaskUpdatedPayload["source"];
  readonly freshness: TaskUpdatedPayload["freshness"];
  readonly createdAt?: string | undefined;
  readonly turnId?: TaskUpdatedPayload["turnId"] | undefined;
}

const text = (value: unknown, field: Parameters<typeof boundSubagentText>[1]) =>
  boundSubagentText(value, field);

function optional<K extends string, V>(key: K, value: V | undefined) {
  return (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
}

/** Normalized, bounded `task.updated` payload for one provider subagent. */
export function providerSubagentPayload(input: ProviderSubagentUpdate): TaskUpdatedPayload {
  const metrics = input.metrics
    ? normalizeSubagentMetrics(input.metrics, input.previousMetrics)
    : undefined;
  const depth =
    input.depth !== undefined && Number.isSafeInteger(input.depth) && input.depth >= 0
      ? input.depth
      : undefined;
  const steps = input.recentSteps?.slice(-PROVIDER_SUBAGENT_RECENT_STEPS_MAX);
  return {
    taskId: input.taskId,
    kind: "providerSubagent",
    nativeId: input.nativeId,
    activityFresh: input.activityFresh ?? input.status === "inProgress",
    status: input.status,
    subject: text(input.subject, "subject") ?? "Subagent",
    ...optional("description", text(input.description, "progressSummary")),
    ...optional("subagentType", text(input.subagentType, "subject")),
    ...optional("agentId", text(input.agentId, "label")),
    ...optional("parentAgentId", text(input.parentAgentId, "label")),
    ...optional("parentToolUseId", text(input.parentToolUseId, "label")),
    ...optional("parentTaskId", input.parentTaskId),
    ...optional("activeLabel", text(input.activeLabel, "label")),
    ...optional("background", input.background),
    ...optional("model", text(input.model, "model")),
    ...optional("effort", text(input.effort, "effort")),
    ...optional("prompt", text(input.prompt, "prompt")),
    ...optional("depth", depth),
    ...optional("progressSummary", text(input.progressSummary, "progressSummary")),
    ...optional("resultSummary", text(input.resultSummary, "resultSummary")),
    ...optional("lastToolName", text(input.lastToolName, "toolName")),
    ...optional("terminalReason", text(input.terminalReason, "progressSummary")),
    ...optional("endedAt", input.endedAt),
    ...optional("metrics", metrics),
    ...optional("recentSteps", steps && steps.length > 0 ? steps : undefined),
    ...optional("usage", input.usage),
    source: input.source,
    freshness: input.freshness,
    ...optional("createdAt", input.createdAt),
    ...optional("turnId", input.turnId),
  };
}

/** One `task.updated` event; `base` comes from the adapter's own event-base helper. */
export function providerSubagentEvent(
  base: ProviderSubagentEventBase,
  input: ProviderSubagentUpdate,
): TaskUpdatedEvent {
  return { ...base, type: "task.updated", payload: providerSubagentPayload(input) };
}
