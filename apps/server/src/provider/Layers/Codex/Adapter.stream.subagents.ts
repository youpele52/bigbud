/**
 * Codex collab subagents: `collabAgentToolCall` (spawnAgent and its follow-ups),
 * `subAgentActivity`, and child-thread tool items, mapped to provider-subagent tasks.
 *
 * Routing is unchanged (D7): child notifications still fold into the parent turn; this
 * tracker only adds `task.updated` rows beside them.
 *
 * Depth: the generated type does not document the `agentPath` format, so depth is the
 * sender's depth plus 1 when the sender is a known subagent thread, and 1 otherwise.
 * `agentPath` is kept only as an opaque bounded label.
 *
 * @module CodexAdapter.stream.subagents
 */
import {
  EventId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type TaskUpdatedPayload,
  type ThreadId,
} from "@bigbud/contracts";
import {
  appendSubagentStep,
  completeSubagentStep,
  type ProviderSubagentStep,
} from "@bigbud/shared/providerSubagents";

import { providerSubagentEvent, providerSubagentTaskId } from "../../providerSubagents.ts";
import {
  collabAgentStatus,
  readChildToolItem,
  readCollabCall,
  readConversationId,
  readItem,
  readSubAgentActivity,
  subAgentActivityStatus,
} from "./Adapter.stream.subagents.items.ts";

const MAX_AGENTS_PER_THREAD = 64;
const MAX_THREADS = 256;

interface CodexAgent {
  readonly nativeId: string;
  status: TaskUpdatedPayload["status"];
  depth: number;
  parentTaskId?: TaskUpdatedPayload["parentTaskId"];
  prompt?: string;
  model?: string;
  effort?: string;
  agentPath?: string;
  message?: string;
  terminalReason?: string;
  endedAt?: string;
  lastToolName?: string;
  steps?: ReadonlyArray<ProviderSubagentStep>;
  readonly createdAt: string;
}

interface ThreadState {
  ordinal: number;
  readonly agents: Map<string, CodexAgent>;
}

const isTerminal = (status: TaskUpdatedPayload["status"]) =>
  status === "completed" || status === "failed" || status === "stopped";

export function makeCodexSubagentTracker() {
  const threads = new Map<ThreadId, ThreadState>();

  function threadState(threadId: ThreadId): ThreadState {
    let state = threads.get(threadId);
    if (state) {
      threads.delete(threadId);
    } else {
      state = { ordinal: 0, agents: new Map() };
    }
    threads.set(threadId, state);
    if (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value!);
    return state;
  }

  function agentFor(state: ThreadState, id: string, createdAt: string, sender?: string) {
    let agent = state.agents.get(id);
    if (agent) return agent;
    if (state.agents.size >= MAX_AGENTS_PER_THREAD) return undefined;
    const parent = sender ? state.agents.get(sender) : undefined;
    agent = {
      nativeId: id,
      status: "inProgress",
      depth: parent ? parent.depth + 1 : 1,
      createdAt,
    };
    state.agents.set(id, agent);
    return agent;
  }

  function setStatus(
    agent: CodexAgent,
    next: { readonly status: TaskUpdatedPayload["status"]; readonly terminalReason?: string },
    at: string,
  ) {
    agent.status = next.status;
    if (isTerminal(next.status)) {
      agent.endedAt ??= at;
      if (next.terminalReason) agent.terminalReason = next.terminalReason;
    } else {
      delete agent.endedAt;
      delete agent.terminalReason;
    }
  }

  function toEvent(event: ProviderEvent, state: ThreadState, agent: CodexAgent) {
    const ordinal = ++state.ordinal;
    const terminal = isTerminal(agent.status);
    return providerSubagentEvent(
      {
        eventId: EventId.makeUnsafe(`${event.id}:subagent:${agent.nativeId}`),
        provider: "codex",
        threadId: event.threadId,
        createdAt: event.createdAt,
        sessionEpoch: event.sessionEpoch,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        raw: {
          source: "codex.app-server.notification",
          method: event.method,
          payload: { agentThreadId: agent.nativeId },
        },
      },
      {
        taskId: providerSubagentTaskId(
          "codex",
          event.threadId,
          event.sessionEpoch ?? 0,
          agent.nativeId,
        ),
        nativeId: agent.nativeId,
        status: agent.status,
        subject: agent.agentPath ?? agent.prompt ?? "Codex agent",
        agentId: agent.nativeId,
        activeLabel: agent.agentPath,
        ...(agent.parentTaskId ? { parentTaskId: agent.parentTaskId } : {}),
        depth: agent.depth,
        prompt: agent.prompt,
        model: agent.model,
        effort: agent.effort,
        lastToolName: agent.lastToolName,
        ...(agent.steps ? { recentSteps: agent.steps } : {}),
        ...(terminal ? { resultSummary: agent.message } : { progressSummary: agent.message }),
        terminalReason: agent.terminalReason,
        ...(agent.endedAt ? { endedAt: agent.endedAt } : {}),
        source: "lifecycle",
        freshness: {
          sessionEpoch: String(event.sessionEpoch ?? 0),
          sourcePriority: 3,
          providerTimestamp: event.createdAt,
          observedOrdinal: ordinal,
        },
        createdAt: agent.createdAt,
        ...(event.turnId ? { turnId: event.turnId } : {}),
      },
    );
  }

  function map(event: ProviderEvent): ReadonlyArray<ProviderRuntimeEvent> {
    if (event.kind !== "notification") return [];
    if (event.method === "session/exited" || event.method === "session/closed") {
      threads.delete(event.threadId);
      return [];
    }
    if (event.method !== "item/started" && event.method !== "item/completed") return [];
    const item = readItem(event.payload);
    if (!item) return [];
    const state = threads.get(event.threadId);
    const call = readCollabCall(item);
    if (call) {
      const current = threadState(event.threadId);
      const touched: CodexAgent[] = [];
      const receivers =
        call.tool === "spawnAgent" ? call.receiverThreadIds : [...call.states.keys()];
      for (const id of receivers) {
        const agent =
          call.tool === "spawnAgent"
            ? agentFor(current, id, event.createdAt, call.senderThreadId)
            : current.agents.get(id);
        if (!agent) continue;
        if (call.tool === "spawnAgent") {
          const parent = call.senderThreadId ? current.agents.get(call.senderThreadId) : undefined;
          if (parent && parent !== agent) {
            agent.parentTaskId = providerSubagentTaskId(
              "codex",
              event.threadId,
              event.sessionEpoch ?? 0,
              parent.nativeId,
            );
          }
          if (call.prompt) agent.prompt = call.prompt;
          if (call.model) agent.model = call.model;
          if (call.effort) agent.effort = call.effort;
        }
        const native = call.states.get(id);
        const mapped = native ? collabAgentStatus(native.status) : undefined;
        if (mapped) setStatus(agent, mapped, event.createdAt);
        if (native?.message) agent.message = native.message;
        touched.push(agent);
      }
      return touched.map((agent) => toEvent(event, current, agent));
    }
    const activity = readSubAgentActivity(item);
    if (activity) {
      const status = subAgentActivityStatus(activity.kind);
      const current = threadState(event.threadId);
      const agent = agentFor(current, activity.agentThreadId, event.createdAt);
      if (!agent) return [];
      if (status) setStatus(agent, { status }, event.createdAt);
      if (activity.model) agent.model = activity.model;
      if (activity.effort) agent.effort = activity.effort;
      if (activity.agentPath) agent.agentPath = activity.agentPath;
      return [toEvent(event, current, agent)];
    }
    const conversationId = readConversationId(event.payload);
    const agent = conversationId ? state?.agents.get(conversationId) : undefined;
    const tool = agent ? readChildToolItem(item, event.method) : undefined;
    if (!state || !agent || !tool || isTerminal(agent.status)) return [];
    const before = agent.steps;
    agent.steps =
      tool.finished && before?.some((step) => step.id === tool.id)
        ? completeSubagentStep(before, tool.id, tool.failed ? "failed" : "completed")
        : appendSubagentStep(before, {
            id: tool.id,
            toolName: tool.toolName,
            label: tool.label,
            status: tool.finished ? (tool.failed ? "failed" : "completed") : "running",
            at: event.createdAt,
          });
    agent.lastToolName = tool.toolName;
    return [toEvent(event, state, agent)];
  }

  return { map };
}
