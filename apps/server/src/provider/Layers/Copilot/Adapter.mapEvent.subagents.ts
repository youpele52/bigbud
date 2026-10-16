/**
 * Copilot `subagent.*` lifecycle and `agentId`-tagged tool events as provider subagents.
 *
 * Model, metrics (tokens, tool calls, duration) and the end time come from the lifecycle
 * events; steps come from the subagent's own `tool.execution_start/complete` events.
 *
 * @module CopilotAdapter.mapEvent.subagents
 */
import type { EventId, ProviderRuntimeEvent } from "@bigbud/contracts";
import type { SessionEvent } from "@github/copilot-sdk";
import {
  appendSubagentStep,
  completeSubagentStep,
  type ProviderSubagentStep,
} from "@bigbud/shared/providerSubagents";

import {
  providerSubagentEvent,
  providerSubagentTaskId,
  type ProviderSubagentUpdate,
} from "../../providerSubagents.ts";
import { type ActiveCopilotSession, eventBase } from "./Adapter.types.ts";

interface CopilotAgent {
  readonly nativeId: string;
  readonly subject: string;
  terminal: boolean;
  model?: string;
  steps?: ReadonlyArray<ProviderSubagentStep> | undefined;
  lastToolName?: string;
}

const MAX_TRACKED = 128;
const ordinals = new WeakMap<ActiveCopilotSession, number>();
const terminalCalls = new WeakMap<ActiveCopilotSession, Set<string>>();
const agents = new WeakMap<ActiveCopilotSession, Map<string, CopilotAgent>>();

function nextOrdinal(session: ActiveCopilotSession): number {
  const next = (ordinals.get(session) ?? 0) + 1;
  ordinals.set(session, next);
  return next;
}

function remember<T>(set: Set<T> | Map<T, unknown>, key: T) {
  if (set.size > MAX_TRACKED) set.delete(set.keys().next().value!);
  return key;
}

type LifecycleEvent = Extract<
  SessionEvent,
  { type: "subagent.started" | "subagent.completed" | "subagent.failed" }
>;

function update(
  session: ActiveCopilotSession,
  event: SessionEvent,
  eventId: EventId,
  input: Omit<ProviderSubagentUpdate, "taskId" | "freshness" | "createdAt" | "turnId"> & {
    readonly sourcePriority: number;
  },
): ProviderRuntimeEvent {
  const turnId = session.activeTurnId;
  const { sourcePriority, ...rest } = input;
  return providerSubagentEvent(
    eventBase({
      eventId,
      createdAt: event.timestamp,
      threadId: session.threadId,
      sessionEpoch: session.sessionEpoch,
      ...(turnId ? { turnId } : {}),
      raw: {
        source: "copilot.sdk.session-event",
        method: event.type,
        payload: { agentId: event.agentId, toolCallId: readToolCallId(event) },
      },
    }),
    {
      ...rest,
      taskId: providerSubagentTaskId(
        "copilot",
        session.threadId,
        session.sessionEpoch,
        rest.nativeId,
      ),
      freshness: {
        sessionEpoch: String(session.sessionEpoch),
        sourcePriority,
        providerTimestamp: event.timestamp,
        observedOrdinal: nextOrdinal(session),
      },
      createdAt: event.timestamp,
      ...(turnId ? { turnId } : {}),
    },
  );
}

function readToolCallId(event: SessionEvent): string | undefined {
  const data = event.data as { toolCallId?: unknown } | undefined;
  return typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
}

function mapLifecycle(session: ActiveCopilotSession, event: LifecycleEvent, eventId: EventId) {
  const terminal = terminalCalls.get(session) ?? new Set<string>();
  terminalCalls.set(session, terminal);
  if (event.type === "subagent.started" && terminal.has(event.data.toolCallId)) return [];
  if (event.type !== "subagent.started") terminal.add(remember(terminal, event.data.toolCallId));
  const nativeId = event.data.toolCallId;
  const subject = (event.data.agentDisplayName || event.data.agentName).slice(0, 120);
  const known = agents.get(session) ?? new Map<string, CopilotAgent>();
  agents.set(session, known);
  const agent: CopilotAgent = (event.agentId ? known.get(event.agentId) : undefined) ?? {
    nativeId,
    subject,
    terminal: false,
  };
  agent.terminal = event.type !== "subagent.started";
  if (event.data.model) agent.model = event.data.model;
  if (event.agentId) known.set(remember(known, event.agentId), agent);
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
          ...(event.data.totalTokens !== undefined ? { totalTokens: event.data.totalTokens } : {}),
          ...(event.data.totalToolCalls !== undefined
            ? { totalToolCalls: event.data.totalToolCalls }
            : {}),
          ...(event.data.durationMs !== undefined ? { durationMs: event.data.durationMs } : {}),
        };
  const metrics =
    event.type === "subagent.started"
      ? undefined
      : {
          totalTokens: event.data.totalTokens,
          toolUses: event.data.totalToolCalls,
          durationMs: event.data.durationMs,
        };
  return [
    update(session, event, eventId, {
      nativeId,
      status,
      activityFresh: true,
      subject,
      ...(event.type === "subagent.started" ? { description: event.data.agentDescription } : {}),
      subagentType: event.data.agentName,
      ...(event.agentId ? { agentId: event.agentId } : {}),
      parentToolUseId: event.data.toolCallId,
      ...(agent.model ? { model: agent.model } : {}),
      ...(metrics ? { metrics } : {}),
      ...(agent.steps ? { recentSteps: agent.steps } : {}),
      ...(event.type === "subagent.failed" ? { terminalReason: event.data.error } : {}),
      ...(status !== "inProgress" ? { endedAt: event.timestamp } : {}),
      ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
      source: "lifecycle",
      sourcePriority: 4,
    }),
  ];
}

export function mapCopilotSubagentEvent(
  session: ActiveCopilotSession,
  event: SessionEvent,
  eventId: EventId,
): ReadonlyArray<ProviderRuntimeEvent> | undefined {
  if (
    event.type === "subagent.started" ||
    event.type === "subagent.completed" ||
    event.type === "subagent.failed"
  )
    return mapLifecycle(session, event, eventId);
  if (!event.agentId) return undefined;
  const agent = agents.get(session)?.get(event.agentId);
  if (!agent || agent.terminal) return [];
  if (event.type === "tool.execution_start") {
    agent.steps = appendSubagentStep(agent.steps, {
      id: event.data.toolCallId,
      toolName: event.data.toolName,
      status: "running",
      at: event.timestamp,
    });
    agent.lastToolName = event.data.toolName;
  } else if (event.type === "tool.execution_complete") {
    const steps = completeSubagentStep(
      agent.steps,
      event.data.toolCallId,
      event.data.success ? "completed" : "failed",
    );
    if (steps === agent.steps) return [];
    agent.steps = steps;
  } else return [];
  return [
    update(session, event, eventId, {
      nativeId: agent.nativeId,
      status: "inProgress",
      subject: agent.subject,
      agentId: event.agentId,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.lastToolName ? { lastToolName: agent.lastToolName } : {}),
      ...(agent.steps ? { recentSteps: agent.steps } : {}),
      source: "observed",
      sourcePriority: 2,
    }),
  ];
}
