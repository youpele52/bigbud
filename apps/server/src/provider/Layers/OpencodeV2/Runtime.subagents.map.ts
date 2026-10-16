/**
 * Pure mapping from an observed OpenCode V2 child session to a provider-subagent task.
 *
 * Read-only: nothing here mutates a child, registers it as an owner, or claims liveness.
 *
 * @module OpencodeV2Runtime.subagents.map
 */
import type { SessionActive, SessionInfo, SessionMessageInfo } from "@opencode/client";
import type { TaskUpdatedPayload, ThreadId } from "@bigbud/contracts";
import { boundSubagentText, normalizeSubagentMetrics } from "@bigbud/shared/providerSubagents";

import { providerSubagentTaskId } from "../../providerSubagents.ts";

/** Children observed per owner; matches the EventHub child index bound. */
export const V2_SUBAGENT_MAX_CHILDREN = 32;
/** Native tool that spawns a child session (advertised as `subagent` by the pinned runtime). */
export const V2_SUBAGENT_TOOL_NAME = "subagent";

export type V2SubagentStatus = TaskUpdatedPayload["status"];

/** Everything but freshness and source; equal content means no update is emitted. */
export type V2SubagentContent = Omit<TaskUpdatedPayload, "freshness" | "source">;

export function v2SubagentTaskId(threadId: ThreadId, epoch: number, childId: string) {
  return providerSubagentTaskId("opencodeV2", threadId, epoch, childId);
}

/** Whether the parent's projected output contains a native subagent tool call. */
export function hasV2SubagentCall(assistants: ReadonlyArray<SessionMessageInfo>): boolean {
  return assistants.some(
    (message) =>
      message.type === "assistant" &&
      message.content.some((part) => part.type === "tool" && part.name === V2_SUBAGENT_TOOL_NAME),
  );
}

/** Direct, non-fork children of `parentId`, bounded. Forks are never subagents. */
export function v2ObservedChildren(
  listing: ReadonlyArray<SessionInfo>,
  parentId: string,
): SessionInfo[] {
  return listing
    .filter((child) => child.parentID === parentId && child.id !== parentId && !child.fork)
    .slice(0, V2_SUBAGENT_MAX_CHILDREN);
}

export function v2SubagentStatus(
  child: SessionInfo,
  active: Readonly<Record<string, SessionActive>>,
): { readonly status: V2SubagentStatus; readonly terminalReason?: string } {
  if (active[child.id]?.type === "running") return { status: "inProgress" };
  switch (child.outcome) {
    case "succeeded":
      return { status: "completed" };
    case "failed":
      return { status: "failed" };
    case "interrupted":
      return { status: "stopped", terminalReason: "interrupted" };
    default:
      return { status: "pending" };
  }
}

const isTerminal = (status: V2SubagentStatus) =>
  status === "completed" || status === "failed" || status === "stopped";

export const isV2SubagentLive = (content: V2SubagentContent) => !isTerminal(content.status);

function isoTime(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function childMetrics(child: SessionInfo, endedMs: number | undefined) {
  const tokens = child.tokens;
  const total = tokens ? tokens.input + tokens.output + tokens.reasoning : 0;
  const duration =
    endedMs !== undefined && endedMs >= child.time.created
      ? endedMs - child.time.created
      : undefined;
  // Zero means "not reported yet" for a child that has not run; it is shown as absent.
  return normalizeSubagentMetrics({
    ...(total > 0 ? { totalTokens: total } : {}),
    ...(child.cost > 0 ? { costUsd: child.cost } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
  });
}

export function mapV2Subagent(input: {
  readonly threadId: ThreadId;
  readonly epoch: number;
  readonly child: SessionInfo;
  readonly active: Readonly<Record<string, SessionActive>>;
  readonly turnId?: TaskUpdatedPayload["turnId"];
}): V2SubagentContent {
  const { child } = input;
  const { status, terminalReason } = v2SubagentStatus(child, input.active);
  const endedMs = isTerminal(status) ? (child.time.idle ?? child.time.updated) : undefined;
  const agent = boundSubagentText(child.agent, "subject");
  const title = boundSubagentText(child.title, "progressSummary");
  const model = child.model
    ? boundSubagentText(`${child.model.providerID}/${child.model.id}`, "model")
    : undefined;
  const effort = boundSubagentText(child.model?.variant, "effort");
  const metrics = childMetrics(child, endedMs);
  const createdAt = isoTime(child.time.created);
  const endedAt = isoTime(endedMs);
  return {
    taskId: v2SubagentTaskId(input.threadId, input.epoch, child.id),
    kind: "providerSubagent",
    nativeId: child.id,
    agentId: child.id,
    activityFresh: status === "inProgress",
    status,
    subject: agent ?? boundSubagentText(child.title, "subject") ?? "Subagent",
    ...(title ? { description: title } : {}),
    ...(agent ? { subagentType: agent } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    depth: 1,
    ...(metrics ? { metrics } : {}),
    ...(terminalReason ? { terminalReason } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
  };
}

/** A failed read keeps the last known state, marked "last seen" (not fresh). */
export function demoteV2Subagent(content: V2SubagentContent): V2SubagentContent | undefined {
  if (isTerminal(content.status) || content.activityFresh === false) return undefined;
  return { ...content, activityFresh: false };
}
