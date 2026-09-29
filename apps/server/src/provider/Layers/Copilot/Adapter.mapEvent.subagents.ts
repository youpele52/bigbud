import { RuntimeTaskId, type EventId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import type { SessionEvent } from "@github/copilot-sdk";

import { type ActiveCopilotSession, eventBase } from "./Adapter.types.ts";

const ordinals = new WeakMap<ActiveCopilotSession, number>();
const terminalCalls = new WeakMap<ActiveCopilotSession, Set<string>>();
const agents = new WeakMap<
  ActiveCopilotSession,
  Map<string, { nativeId: string; subject: string; terminal: boolean }>
>();

function nextOrdinal(session: ActiveCopilotSession): number {
  const next = (ordinals.get(session) ?? 0) + 1;
  ordinals.set(session, next);
  return next;
}

export function mapCopilotSubagentEvent(
  session: ActiveCopilotSession,
  event: SessionEvent,
  eventId: EventId,
): ReadonlyArray<ProviderRuntimeEvent> | undefined {
  const turnId = session.activeTurnId;
  if (
    event.type === "subagent.started" ||
    event.type === "subagent.completed" ||
    event.type === "subagent.failed"
  ) {
    const terminal = terminalCalls.get(session) ?? new Set<string>();
    if (event.type === "subagent.started" && terminal.has(event.data.toolCallId)) return [];
    if (event.type !== "subagent.started") {
      terminal.add(event.data.toolCallId);
      if (terminal.size > 128) terminal.delete(terminal.values().next().value!);
      terminalCalls.set(session, terminal);
    }
    const nativeId = event.data.toolCallId;
    const subject = (event.data.agentDisplayName || event.data.agentName).slice(0, 120);
    const status =
      event.type === "subagent.started"
        ? "inProgress"
        : event.type === "subagent.failed"
          ? "failed"
          : "completed";
    const usage =
      event.type === "subagent.started"
        ? undefined
        : {
            ...(event.data.totalTokens !== undefined
              ? { totalTokens: event.data.totalTokens }
              : {}),
            ...(event.data.totalToolCalls !== undefined
              ? { totalToolCalls: event.data.totalToolCalls }
              : {}),
            ...(event.data.durationMs !== undefined ? { durationMs: event.data.durationMs } : {}),
          };
    if (event.agentId) {
      const known = agents.get(session) ?? new Map();
      known.set(event.agentId, {
        nativeId,
        subject,
        terminal: event.type !== "subagent.started",
      });
      agents.set(session, known);
    }
    return [
      {
        ...eventBase({
          eventId,
          createdAt: event.timestamp,
          threadId: session.threadId,
          sessionEpoch: session.sessionEpoch,
          ...(turnId ? { turnId } : {}),
          raw: {
            source: "copilot.sdk.session-event",
            method: event.type,
            payload: { agentId: event.agentId, toolCallId: event.data.toolCallId },
          },
        }),
        type: "task.updated",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe(
            `copilot:${session.threadId}:${session.sessionEpoch}:${nativeId}`,
          ),
          kind: "providerSubagent",
          nativeId,
          activityFresh: true,
          status,
          subject,
          ...(event.type === "subagent.started"
            ? { description: event.data.agentDescription.slice(0, 500) }
            : {}),
          ...(event.agentId ? { agentId: event.agentId } : {}),
          parentToolUseId: event.data.toolCallId,
          ...(event.type === "subagent.failed"
            ? { terminalReason: event.data.error.slice(0, 500) }
            : {}),
          ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
          source: "lifecycle",
          freshness: {
            sessionEpoch: String(session.sessionEpoch),
            sourcePriority: 4,
            providerTimestamp: event.timestamp,
            observedOrdinal: nextOrdinal(session),
          },
          createdAt: event.timestamp,
          ...(turnId ? { turnId } : {}),
        },
      },
    ];
  }
  if (!event.agentId) return undefined;
  const agent = agents.get(session)?.get(event.agentId);
  if (!agent || agent.terminal || event.type !== "tool.execution_start") return [];
  return [
    {
      ...eventBase({
        eventId,
        createdAt: event.timestamp,
        threadId: session.threadId,
        sessionEpoch: session.sessionEpoch,
        ...(turnId ? { turnId } : {}),
        raw: {
          source: "copilot.sdk.session-event",
          method: event.type,
          payload: { agentId: event.agentId, toolCallId: event.data.toolCallId },
        },
      }),
      type: "task.updated",
      payload: {
        taskId: RuntimeTaskId.makeUnsafe(
          `copilot:${session.threadId}:${session.sessionEpoch}:${agent.nativeId}`,
        ),
        kind: "providerSubagent",
        nativeId: agent.nativeId,
        activityFresh: true,
        status: "inProgress",
        subject: agent.subject,
        agentId: event.agentId,
        lastToolName: event.data.toolName.slice(0, 120),
        source: "observed",
        freshness: {
          sessionEpoch: String(session.sessionEpoch),
          sourcePriority: 2,
          providerTimestamp: event.timestamp,
          observedOrdinal: nextOrdinal(session),
        },
        createdAt: event.timestamp,
        ...(turnId ? { turnId } : {}),
      },
    },
  ];
}
