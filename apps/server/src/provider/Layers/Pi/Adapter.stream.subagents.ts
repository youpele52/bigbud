import { randomUUID } from "node:crypto";

import { EventId, type ProviderRuntimeEvent } from "@bigbud/contracts";

import { providerSubagentEvent, providerSubagentTaskId } from "../../providerSubagents.ts";
import type { ActivePiSession } from "./Adapter.types.ts";
import { piSubagentDetail, type PiSubagentDetail } from "./Adapter.stream.subagents.detail.ts";
import { eventBase, isRecord } from "./Adapter.utils.ts";

type Result = {
  agent: string;
  task: string;
  exitCode: number;
  step?: number;
  stopReason?: string;
  errorMessage?: string;
  messages?: ReadonlyArray<unknown>;
  model?: unknown;
  usage?: unknown;
};
type StoredResult = Omit<Result, "messages" | "usage"> & { detail: PiSubagentDetail };
type Parsed = { mode: "single" | "parallel" | "chain"; results: StoredResult[] };

const observedOrdinals = new WeakMap<ActivePiSession, number>();
const terminalCalls = new WeakMap<ActivePiSession, Set<string>>();
const lastResults = new WeakMap<ActivePiSession, Map<string, Parsed>>();
const MAX_TRACKED_CALLS = 128;

function parse(value: unknown, at: string): Parsed | undefined {
  const record = isRecord(value) ? value : undefined;
  const source = isRecord(record?.details) ? record.details : record;
  if (!source || !["single", "parallel", "chain"].includes(String(source.mode))) return;
  if (!Array.isArray(source.results) || source.results.length > 16) return;
  const results: StoredResult[] = [];
  for (const value of source.results) {
    if (
      !isRecord(value) ||
      typeof value.agent !== "string" ||
      !value.agent.trim() ||
      typeof value.task !== "string" ||
      !value.task.trim() ||
      typeof value.exitCode !== "number" ||
      !Number.isInteger(value.exitCode)
    )
      return;
    const result = value as Result;
    results.push({
      agent: result.agent.slice(0, 120),
      task: result.task.slice(0, 500),
      exitCode: result.exitCode,
      ...(result.step !== undefined ? { step: result.step } : {}),
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage.slice(0, 500) } : {}),
      detail: piSubagentDetail(result, at),
    });
  }
  return { mode: source.mode as Parsed["mode"], results };
}

export function mapPiSubagentResults(input: {
  session: ActivePiSession;
  toolCallId: string;
  toolName: string | undefined;
  result: unknown;
  final: boolean;
  isError?: boolean;
  createdAt: string;
}): ReadonlyArray<ProviderRuntimeEvent> {
  if (input.toolName !== "subagent") return [];
  const terminal = terminalCalls.get(input.session) ?? new Set<string>();
  if (!input.final && terminal.has(input.toolCallId)) return [];
  const finalResult = parse(input.result, input.createdAt);
  const prior = lastResults.get(input.session) ?? new Map<string, Parsed>();
  const parsed = finalResult ?? (input.final ? prior.get(input.toolCallId) : undefined);
  if (!parsed) return [];
  if (!input.final) {
    prior.set(input.toolCallId, parsed);
    if (prior.size > MAX_TRACKED_CALLS) prior.delete(prior.keys().next().value!);
    lastResults.set(input.session, prior);
  }
  if (input.final) {
    terminal.add(input.toolCallId);
    if (terminal.size > MAX_TRACKED_CALLS) terminal.delete(terminal.values().next().value!);
    terminalCalls.set(input.session, terminal);
    prior.delete(input.toolCallId);
  }
  const { session } = input;
  const turnId = session.activeTurnId;
  return parsed.results.map((result, index) => {
    const observedOrdinal = (observedOrdinals.get(session) ?? 0) + 1;
    observedOrdinals.set(session, observedOrdinal);
    const nativeId = `${input.toolCallId}:${parsed.mode}:${result.step ?? index}`;
    const failed =
      input.final &&
      (input.isError || (finalResult && (result.exitCode !== 0 || result.stopReason === "error")));
    const status = input.final
      ? failed
        ? "failed"
        : finalResult
          ? "completed"
          : "pending"
      : "inProgress";
    const { detail } = result;
    return providerSubagentEvent(
      eventBase({
        eventId: EventId.makeUnsafe(randomUUID()),
        createdAt: input.createdAt,
        threadId: session.threadId,
        sessionEpoch: session.sessionEpoch,
        ...(turnId ? { turnId } : {}),
        raw: {
          source: "pi.rpc.event",
          messageType: input.final ? "tool_execution_end" : "tool_execution_update",
          payload: { toolCallId: input.toolCallId },
        },
      }),
      {
        taskId: providerSubagentTaskId("pi", session.threadId, session.sessionEpoch, nativeId),
        nativeId,
        status,
        subject: result.agent,
        description: result.task,
        prompt: result.task,
        activeLabel: `${parsed.mode} mode`,
        parentToolUseId: input.toolCallId,
        subagentType: result.agent,
        model: detail.model,
        lastToolName: detail.lastToolName,
        ...(detail.steps ? { recentSteps: detail.steps } : {}),
        ...(detail.metrics ? { metrics: detail.metrics } : {}),
        ...(input.final
          ? { resultSummary: detail.summary, endedAt: input.createdAt }
          : { progressSummary: detail.summary }),
        ...(detail.usage ? { usage: detail.usage } : {}),
        ...(failed
          ? { terminalReason: result.errorMessage || result.stopReason || "Subagent failed" }
          : {}),
        source: "observed",
        freshness: {
          sessionEpoch: String(session.sessionEpoch),
          sourcePriority: input.final ? 4 : 2,
          providerTimestamp: input.createdAt,
          observedOrdinal,
        },
        createdAt: input.createdAt,
        ...(turnId ? { turnId } : {}),
      },
    );
  });
}
