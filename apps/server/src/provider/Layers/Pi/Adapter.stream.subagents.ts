import { randomUUID } from "node:crypto";

import { EventId, RuntimeTaskId, type ProviderRuntimeEvent } from "@bigbud/contracts";

import type { ActivePiSession } from "./Adapter.types.ts";
import { eventBase, isRecord } from "./Adapter.utils.ts";

type Result = {
  agent: string;
  task: string;
  exitCode: number;
  step?: number;
  stopReason?: string;
  errorMessage?: string;
  messages?: ReadonlyArray<unknown>;
  summary?: string;
  usage?: unknown;
};
const observedOrdinals = new WeakMap<ActivePiSession, number>();
const terminalCalls = new WeakMap<ActivePiSession, Set<string>>();
const lastResults = new WeakMap<
  ActivePiSession,
  Map<string, NonNullable<ReturnType<typeof parse>>>
>();
const MAX_TRACKED_CALLS = 128;

function parse(
  value: unknown,
): { mode: "single" | "parallel" | "chain"; results: Result[] } | undefined {
  const record = isRecord(value) ? value : undefined;
  const source = isRecord(record?.details) ? record.details : record;
  if (!source || !["single", "parallel", "chain"].includes(String(source.mode))) return;
  if (!Array.isArray(source.results) || source.results.length > 16) return;
  const results: Result[] = [];
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
    results.push(value as Result);
  }
  return { mode: source.mode as "single" | "parallel" | "chain", results };
}

function lastText(messages: ReadonlyArray<unknown> | undefined): string | undefined {
  if (!Array.isArray(messages)) return;
  for (const message of messages.toReversed()) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content.toReversed()) {
      if (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim()
      )
        return part.text.trim().slice(0, 500);
    }
  }
}

function boundedUsage(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return;
  const keys = [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cost",
    "contextTokens",
    "turns",
  ] as const;
  const usage: Record<string, number> = {};
  for (const key of keys) {
    const number = value[key];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) usage[key] = number;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
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
  const finalResult = parse(input.result);
  const prior =
    lastResults.get(input.session) ?? new Map<string, NonNullable<ReturnType<typeof parse>>>();
  const parsed = finalResult ?? (input.final ? prior.get(input.toolCallId) : undefined);
  if (!parsed) return [];
  if (!input.final) {
    prior.set(input.toolCallId, {
      mode: parsed.mode,
      results: parsed.results.map((result) => ({
        agent: result.agent.slice(0, 120),
        task: result.task.slice(0, 500),
        exitCode: result.exitCode,
        ...(result.step !== undefined ? { step: result.step } : {}),
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        ...(result.errorMessage ? { errorMessage: result.errorMessage.slice(0, 500) } : {}),
        ...(lastText(result.messages) ? { summary: lastText(result.messages)! } : {}),
        ...(boundedUsage(result.usage) ? { usage: boundedUsage(result.usage) } : {}),
      })),
    });
    if (prior.size > MAX_TRACKED_CALLS) prior.delete(prior.keys().next().value!);
    lastResults.set(input.session, prior);
  }
  if (input.final) {
    terminal.add(input.toolCallId);
    if (terminal.size > MAX_TRACKED_CALLS) terminal.delete(terminal.values().next().value!);
    terminalCalls.set(input.session, terminal);
    prior.delete(input.toolCallId);
  }
  const events: ProviderRuntimeEvent[] = [];
  for (const [index, result] of parsed.results.entries()) {
    const observedOrdinal = (observedOrdinals.get(input.session) ?? 0) + 1;
    observedOrdinals.set(input.session, observedOrdinal);
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
    const summary = lastText(result.messages) ?? result.summary;
    const usage = boundedUsage(result.usage);
    events.push({
      ...eventBase({
        eventId: EventId.makeUnsafe(randomUUID()),
        createdAt: input.createdAt,
        threadId: input.session.threadId,
        sessionEpoch: input.session.sessionEpoch,
        ...(input.session.activeTurnId ? { turnId: input.session.activeTurnId } : {}),
        raw: {
          source: "pi.rpc.event",
          messageType: input.final ? "tool_execution_end" : "tool_execution_update",
          payload: { toolCallId: input.toolCallId },
        },
      }),
      type: "task.updated" as const,
      payload: {
        taskId: RuntimeTaskId.makeUnsafe(
          `pi:${input.session.threadId}:${input.session.sessionEpoch}:${nativeId}`,
        ),
        kind: "providerSubagent" as const,
        nativeId,
        activityFresh: status === "inProgress",
        status,
        subject: result.agent.slice(0, 120),
        description: result.task.slice(0, 500),
        activeLabel: `${parsed.mode} mode`,
        parentToolUseId: input.toolCallId,
        subagentType: result.agent.slice(0, 120),
        ...(summary ? { progressSummary: summary } : {}),
        ...(usage ? { usage } : {}),
        ...(failed
          ? {
              terminalReason: (result.errorMessage || result.stopReason || "Subagent failed").slice(
                0,
                500,
              ),
            }
          : {}),
        source: "observed" as const,
        freshness: {
          sessionEpoch: String(input.session.sessionEpoch),
          sourcePriority: input.final ? 4 : 2,
          providerTimestamp: input.createdAt,
          observedOrdinal,
        },
        createdAt: input.createdAt,
        ...(input.session.activeTurnId ? { turnId: input.session.activeTurnId } : {}),
      },
    });
  }
  return events;
}
