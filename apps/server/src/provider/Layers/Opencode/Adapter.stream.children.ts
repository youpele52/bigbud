import { randomUUID } from "node:crypto";

import { EventId, RuntimeTaskId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import type { Event, Message, Part, Session } from "@opencode-ai/sdk/v2";

import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { eventBase } from "./Adapter.stream.utils.ts";

const MAX_CHILDREN = 32;
const MAX_PROGRESS_LENGTH = 500;
const PROGRESS_EMIT_INTERVAL_MS = 250;
type ChildStatus = "pending" | "inProgress" | "completed" | "failed" | "stopped";
type ChildActivity = {
  assistantMessageId?: string;
  progressPartId?: string;
  progressSummary?: string;
  progressEmittedAt?: number;
  lastToolName?: string;
  terminalReason?: string;
};

function taskCreatedAt(child: Session, observedAt: string) {
  const timestamp = child.time?.created;
  if (!Number.isFinite(timestamp)) return observedAt;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? observedAt : date.toISOString();
}

export function makeChildSessionTracker(session: ActiveOpencodeSession) {
  const children = new Map<string, Session>();
  const statuses = new Map<string, ChildStatus>();
  const activity = new Map<string, ChildActivity>();
  let observedOrdinal = 0;

  function update(child: Session, status: ChildStatus): ProviderRuntimeEvent {
    const observedAt = new Date().toISOString();
    const childActivity = activity.get(child.id);
    const progressSummary = childActivity?.progressSummary?.trim();
    return {
      ...eventBase({
        eventId: EventId.makeUnsafe(randomUUID()),
        createdAt: observedAt,
        threadId: session.threadId,
        sessionEpoch: session.sessionEpoch,
        provider: "opencode",
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
        raw: {
          source: "opencode.sdk.session-event",
          method: "child-session",
          payload: { sessionID: child.id },
        },
      }),
      type: "task.updated",
      payload: {
        taskId: RuntimeTaskId.makeUnsafe(
          `opencode:${session.threadId}:${session.sessionEpoch}:${child.id}`,
        ),
        kind: "providerSubagent",
        nativeId: child.id,
        activityFresh: status === "inProgress",
        status,
        subject: (child.agent || child.title || "Subagent").slice(0, 120),
        ...(child.title ? { description: child.title.slice(0, 500) } : {}),
        ...(child.parentID ? { parentAgentId: child.parentID } : {}),
        ...(progressSummary ? { progressSummary } : {}),
        ...(childActivity?.lastToolName ? { lastToolName: childActivity.lastToolName } : {}),
        ...(childActivity?.terminalReason ? { terminalReason: childActivity.terminalReason } : {}),
        source: "lifecycle",
        freshness: {
          sessionEpoch: String(session.sessionEpoch),
          sourcePriority: 3,
          providerTimestamp: observedAt,
          observedOrdinal: ++observedOrdinal,
        },
        createdAt: taskCreatedAt(child, observedAt),
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      },
    };
  }

  async function refresh(): Promise<ReadonlyArray<ProviderRuntimeEvent>> {
    const output: ProviderRuntimeEvent[] = [];
    const queue = [session.opencodeSessionId];
    while (queue.length && children.size < MAX_CHILDREN) {
      const parent = queue.shift()!;
      const response = await session.client.session
        .children({ sessionID: parent })
        .catch(() => ({ data: undefined }));
      if (!Array.isArray(response.data)) break;
      for (const child of response.data) {
        if (children.size >= MAX_CHILDREN) break;
        if (child.parentID !== parent || children.has(child.id)) continue;
        children.set(child.id, child);
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
    const id = properties.sessionID;
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
      statuses.set(id, "pending");
      activity.set(id, {});
      return [update(info, "pending")];
    }
    if (event.type === "message.updated") {
      const message = properties.info as Message | undefined;
      const childActivity = activity.get(id);
      if (childActivity) {
        if (message?.role === "assistant") childActivity.assistantMessageId = message.id;
        else delete childActivity.assistantMessageId;
      }
      return [];
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
