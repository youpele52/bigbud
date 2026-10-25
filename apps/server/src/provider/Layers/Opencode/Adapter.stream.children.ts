import { randomUUID } from "node:crypto";

import {
  EventId,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type TurnId,
} from "@bigbud/contracts";
import type { Event, Message, Part, Session } from "@opencode-ai/sdk/v2";

import { providerSubagentEvent, providerSubagentTaskId } from "../../providerSubagents.ts";
import { PROVIDER_SUBAGENT_CAPABILITIES } from "../../providerSubagents.capabilities.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { eventBase } from "./Adapter.stream.utils.ts";
import { opencodeEventSessionId } from "./Adapter.stream.identity.ts";
import {
  childMetrics,
  recordChildAssistant,
  recordChildToolPart,
  type ChildActivity,
} from "./Adapter.stream.children.activity.ts";

const MAX_CHILDREN = 32;
const MAX_PROGRESS_LENGTH = 500;
const PROGRESS_EMIT_INTERVAL_MS = 250;
type ChildStatus = "pending" | "inProgress" | "completed" | "failed" | "stopped";

/** Child sessions are tracked only for providers that declare native subagent support. */
export function tracksChildSessions(provider: ProviderKind): boolean {
  return PROVIDER_SUBAGENT_CAPABILITIES[provider].support === "native";
}

function taskCreatedAt(child: Session, observedAt: string) {
  const timestamp = child.time?.created;
  if (!Number.isFinite(timestamp)) return observedAt;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? observedAt : date.toISOString();
}

export function makeChildSessionTracker(
  session: ActiveOpencodeSession,
  provider: "opencode" | "kilocode" = "opencode",
) {
  const children = new Map<string, Session>();
  const statuses = new Map<string, ChildStatus>();
  const activity = new Map<string, ChildActivity>();
  const turns = new Map<string, TurnId | undefined>();
  const ended = new Map<string, string>();
  let observedOrdinal = 0;

  function update(child: Session, status: ChildStatus): ProviderRuntimeEvent {
    const observedAt = new Date().toISOString();
    const childActivity = activity.get(child.id);
    const progressSummary = childActivity?.progressSummary?.trim();
    const metrics = childActivity ? childMetrics(childActivity) : undefined;
    const terminal = status === "completed" || status === "failed" || status === "stopped";
    const turnId = turns.get(child.id);
    if (terminal && !ended.has(child.id)) ended.set(child.id, observedAt);
    if (!terminal) ended.delete(child.id);
    return providerSubagentEvent(
      eventBase({
        eventId: EventId.makeUnsafe(randomUUID()),
        createdAt: observedAt,
        threadId: session.threadId,
        sessionEpoch: session.sessionEpoch,
        provider,
        ...(turnId ? { turnId } : {}),
        raw: {
          source: "opencode.sdk.session-event",
          method: "child-session",
          payload: { sessionID: child.id },
        },
      }),
      {
        taskId: providerSubagentTaskId(provider, session.threadId, session.sessionEpoch, child.id),
        nativeId: child.id,
        status,
        subject: child.agent || child.title,
        subagentType: child.agent,
        agentId: child.id,
        description: child.title,
        parentAgentId: child.parentID,
        progressSummary,
        lastToolName: childActivity?.lastToolName,
        terminalReason: childActivity?.terminalReason,
        model: childActivity?.model,
        ...(metrics ? { metrics } : {}),
        ...(childActivity?.steps ? { recentSteps: childActivity.steps } : {}),
        ...(terminal ? { endedAt: ended.get(child.id) } : {}),
        source: "lifecycle",
        freshness: {
          sessionEpoch: String(session.sessionEpoch),
          sourcePriority: 3,
          providerTimestamp: observedAt,
          observedOrdinal: ++observedOrdinal,
        },
        createdAt: taskCreatedAt(child, observedAt),
        ...(turnId ? { turnId } : {}),
      },
    );
  }

  /** Model, usage or step changes keep the current status; only pending becomes active. */
  function activityUpdate(id: string): ReadonlyArray<ProviderRuntimeEvent> {
    const current = statuses.get(id) ?? "pending";
    const status = current === "pending" ? "inProgress" : current;
    statuses.set(id, status);
    return [update(children.get(id)!, status)];
  }

  async function refresh(): Promise<ReadonlyArray<ProviderRuntimeEvent>> {
    const output: ProviderRuntimeEvent[] = [];
    const queue = [session.opencodeSessionId, ...children.keys()];
    const visited = new Set<string>();
    while (queue.length && children.size < MAX_CHILDREN) {
      const parent = queue.shift()!;
      if (visited.has(parent)) continue;
      visited.add(parent);
      const response = await session.client.session
        .children({ sessionID: parent })
        .catch(() => ({ data: undefined }));
      if (!Array.isArray(response.data)) break;
      for (const child of response.data) {
        if (children.size >= MAX_CHILDREN) break;
        if (child.parentID !== parent || children.has(child.id)) continue;
        children.set(child.id, child);
        turns.set(child.id, session.activeTurnId);
        statuses.set(child.id, "pending");
        activity.set(child.id, {});
        output.push(update(child, "pending"));
        queue.push(child.id);
      }
    }
    const response = await session.client.session.status().catch(() => ({ data: undefined }));
    for (const [id, child] of children) {
      const live = response.data?.[id];
      if (!live) continue;
      const status = live.type === "idle" ? "completed" : "inProgress";
      if (
        status === "completed" &&
        (statuses.get(id) === "failed" || statuses.get(id) === "stopped")
      )
        continue;
      if (statuses.get(id) === status) continue;
      statuses.set(id, status);
      output.push(update(child, status));
    }
    return output;
  }

  async function handle(event: Event): Promise<ReadonlyArray<ProviderRuntimeEvent>> {
    const properties = event.properties as {
      sessionID?: string;
      status?: { type?: string };
      info?: Session | Message;
      part?: Part;
      messageID?: string;
      partID?: string;
      field?: string;
      delta?: string;
      error?: unknown;
    };
    const id = opencodeEventSessionId(event);
    if (!id || id === session.opencodeSessionId) return [];
    if (!children.has(id)) {
      const info = properties.info as Session | undefined;
      const parent = info?.parentID;
      if (
        (event.type !== "session.created" && event.type !== "session.updated") ||
        !info ||
        !parent ||
        (parent !== session.opencodeSessionId && !children.has(parent)) ||
        children.size >= MAX_CHILDREN
      )
        return [];
      children.set(id, info);
      turns.set(id, session.activeTurnId);
      statuses.set(id, "pending");
      activity.set(id, {});
      return [update(info, "pending")];
    }
    if (event.type === "session.updated") {
      const info = properties.info as Session | undefined;
      if (!info || info.id !== id) return [];
      children.set(id, info);
      return [update(info, statuses.get(id) ?? "pending")];
    }
    const current = statuses.get(id);
    // Content arriving after idle/error must not resurrect a finished child. A native
    // busy/retry status is the only evidence that the child has actually resumed.
    if (
      (current === "completed" || current === "failed" || current === "stopped") &&
      (event.type === "message.updated" ||
        event.type === "message.part.updated" ||
        event.type === "message.part.delta")
    )
      return [];
    if (event.type === "message.updated") {
      const message = properties.info as Message | undefined;
      const childActivity = activity.get(id);
      if (!childActivity) return [];
      if (message?.role !== "assistant") {
        delete childActivity.assistantMessageId;
        return [];
      }
      childActivity.assistantMessageId = message.id;
      return recordChildAssistant(childActivity, message) ? activityUpdate(id) : [];
    }
    if (event.type === "message.part.delta") {
      const childActivity = activity.get(id);
      if (
        !childActivity ||
        properties.messageID !== childActivity.assistantMessageId ||
        properties.field !== "text" ||
        !properties.partID ||
        !properties.delta
      )
        return [];
      if (childActivity.progressPartId !== properties.partID) {
        childActivity.progressPartId = properties.partID;
        childActivity.progressSummary = "";
      }
      childActivity.progressSummary =
        `${childActivity.progressSummary ?? ""}${properties.delta}`.slice(-MAX_PROGRESS_LENGTH);
      const now = Date.now();
      if (
        childActivity.progressEmittedAt !== undefined &&
        now - childActivity.progressEmittedAt < PROGRESS_EMIT_INTERVAL_MS
      )
        return [];
      childActivity.progressEmittedAt = now;
      statuses.set(id, "inProgress");
      return [update(children.get(id)!, "inProgress")];
    }
    if (event.type === "message.part.updated") {
      const part = properties.part;
      const childActivity = activity.get(id);
      if (!part || !childActivity || part.messageID !== childActivity.assistantMessageId) return [];
      let changed = false;
      if (part.type === "text" && !part.synthetic && !part.ignored && part.text.trim()) {
        childActivity.progressPartId = part.id;
        const progressSummary = part.text.trim().slice(-MAX_PROGRESS_LENGTH);
        if (childActivity.progressSummary !== progressSummary) {
          childActivity.progressSummary = progressSummary;
          changed = true;
        }
      } else if (part.type === "tool") {
        const title = "title" in part.state ? part.state.title : undefined;
        const lastToolName = (title || part.tool).slice(0, 120);
        if (childActivity.lastToolName !== lastToolName) {
          childActivity.lastToolName = lastToolName;
          changed = true;
        }
        if (recordChildToolPart(childActivity, part, new Date().toISOString())) changed = true;
      }
      if (!changed) return [];
      statuses.set(id, "inProgress");
      return [update(children.get(id)!, "inProgress")];
    }
    if (
      event.type !== "session.status" &&
      event.type !== "session.idle" &&
      event.type !== "session.error" &&
      event.type !== "session.deleted"
    )
      return [];
    const error = properties.error as { data?: { message?: unknown }; name?: unknown } | undefined;
    const status =
      event.type === "session.error"
        ? error?.name === "MessageAbortedError"
          ? "stopped"
          : "failed"
        : event.type === "session.deleted"
          ? "stopped"
          : event.type === "session.idle" || properties.status?.type === "idle"
            ? "completed"
            : "inProgress";
    const currentStatus = statuses.get(id);
    const statusResumed = event.type === "session.status" && properties.status?.type !== "idle";
    if (
      ((currentStatus === "failed" || currentStatus === "stopped") && !statusResumed) ||
      (event.type === "session.deleted" && currentStatus === "completed")
    )
      return [];
    if (statuses.get(id) === status) return [];
    statuses.set(id, status);
    if (event.type === "session.error") {
      const message = error?.data?.message;
      const reason = typeof message === "string" ? message : error?.name;
      if (typeof reason === "string") activity.get(id)!.terminalReason = reason.slice(0, 500);
    }
    return [update(children.get(id)!, status)];
  }

  return { refresh, handle };
}
