import { randomUUID } from "node:crypto";

import { EventId, RuntimeTaskId, type ProviderRuntimeEvent } from "@bigbud/contracts";

import type { ActivePiSession } from "./Adapter.types.ts";
import { eventBase, isRecord, normalizeString } from "./Adapter.utils.ts";
import type { PiRpcExtensionUIRequest } from "./RpcProcess.ts";

const WIDGET_KEY = "subagent-async";
const WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const MAX_WIDGET_BYTES = 33_000;
const MAX_RUNS = 20;
const MAX_AGENTS = 64;
const MAX_DEPTH = 3;
const lastSnapshotAt = new WeakMap<ActivePiSession, number>();
const lastNodes = new WeakMap<ActivePiSession, Map<string, string>>();
const observedOrdinals = new WeakMap<ActivePiSession, number>();

type AsyncState =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "partial"
  | "paused"
  | "stopped"
  | "rejected";
type AsyncNode = {
  id: string;
  kind: "workflow" | "subagent" | "step" | "host-step";
  label: string;
  state: AsyncState;
  startedAt?: number;
  updatedAt?: number;
  activity?: { currentTool?: string; toolCount?: number; turnCount?: number };
  children?: AsyncNode[];
};

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  const number = nonNegativeInteger(value);
  return number !== undefined && Number.isFinite(new Date(number).getTime()) ? number : undefined;
}

function parseNode(value: unknown, depth: number): AsyncNode | undefined {
  if (!isRecord(value) || depth > MAX_DEPTH) return;
  const id = normalizeString(value.id)?.slice(0, 160);
  const label = normalizeString(value.label)?.slice(0, 160);
  const kind = value.kind;
  const state = value.state;
  if (
    !id ||
    !label ||
    (kind !== "workflow" && kind !== "subagent" && kind !== "step" && kind !== "host-step") ||
    typeof state !== "string" ||
    ![
      "queued",
      "running",
      "complete",
      "failed",
      "partial",
      "paused",
      "stopped",
      "rejected",
    ].includes(state)
  )
    return;
  const activity = isRecord(value.activity) ? value.activity : undefined;
  const startedAt = timestamp(value.startedAt);
  const updatedAt = timestamp(value.updatedAt);
  const currentTool = normalizeString(activity?.currentTool)?.slice(0, 120);
  const toolCount = nonNegativeInteger(activity?.toolCount);
  const turnCount = nonNegativeInteger(activity?.turnCount);
  const children = Array.isArray(value.children)
    ? value.children.slice(0, 8).flatMap((child) => {
        const parsed = parseNode(child, depth + 1);
        return parsed ? [parsed] : [];
      })
    : undefined;
  return {
    id,
    label,
    kind,
    state: state as AsyncState,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(activity
      ? {
          activity: {
            ...(currentTool ? { currentTool } : {}),
            ...(toolCount !== undefined ? { toolCount } : {}),
            ...(turnCount !== undefined ? { turnCount } : {}),
          },
        }
      : {}),
    ...(children ? { children } : {}),
  };
}

function parseWidget(message: PiRpcExtensionUIRequest) {
  if (message.method !== "setWidget" || message.widgetKey !== WIDGET_KEY) return;
  if (!message.widgetLines || message.widgetLines.length === 0) {
    return { generatedAt: Date.now(), runs: [] as AsyncNode[] };
  }
  const line = message.widgetLines[0];
  if (
    message.widgetLines?.length !== 1 ||
    !line?.startsWith(WIDGET_PREFIX) ||
    Buffer.byteLength(line, "utf8") > MAX_WIDGET_BYTES
  )
    return;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(WIDGET_PREFIX.length));
  } catch {
    return;
  }
  if (
    !isRecord(value) ||
    value.kind !== "pi-subagents.async-status-snapshot" ||
    value.version !== 1
  )
    return;
  const generatedAt = timestamp(value.generatedAt);
  if (generatedAt === undefined || !Array.isArray(value.runs) || value.runs.length > MAX_RUNS)
    return;
  return {
    generatedAt,
    runs: value.runs.flatMap((run) => {
      const parsed = parseNode(run, 0);
      return parsed ? [parsed] : [];
    }),
  };
}

function taskStatus(
  state: AsyncState,
): "pending" | "inProgress" | "completed" | "failed" | "stopped" {
  switch (state) {
    case "queued":
    case "paused":
      return "pending";
    case "running":
      return "inProgress";
    case "complete":
      return "completed";
    case "stopped":
      return "stopped";
    case "failed":
    case "partial":
    case "rejected":
      return "failed";
  }
}

export function mapPiAsyncSubagentWidget(
  session: ActivePiSession,
  message: PiRpcExtensionUIRequest,
): ReadonlyArray<ProviderRuntimeEvent> {
  const snapshot = parseWidget(message);
  if (!snapshot || snapshot.generatedAt < (lastSnapshotAt.get(session) ?? -1)) return [];
  const generatedAt = snapshot.generatedAt;
  lastSnapshotAt.set(session, generatedAt);
  const createdAt = new Date(generatedAt).toISOString();
  const events: ProviderRuntimeEvent[] = [];
  const seen = new Set<string>();
  let visited = 0;
  const prior = lastNodes.get(session) ?? new Map<string, string>();
  lastNodes.set(session, prior);

  function visit(node: AsyncNode, identity: ReadonlyArray<string>, parentId?: string) {
    const nativeId = [...identity, encodeURIComponent(node.id)].join(":");
    if (node.kind !== "workflow" && node.kind !== "host-step") {
      if (visited >= MAX_AGENTS) return;
      visited += 1;
      const fingerprint = JSON.stringify([
        node.state,
        node.label,
        node.updatedAt,
        node.activity?.currentTool,
        node.activity?.toolCount,
        node.activity?.turnCount,
      ]);
      seen.add(nativeId);
      const unchanged = prior.get(nativeId) === fingerprint;
      prior.set(nativeId, fingerprint);
      if (prior.size > MAX_AGENTS * 2) prior.delete(prior.keys().next().value!);
      if (!unchanged) {
        const status = taskStatus(node.state);
        const observedOrdinal = (observedOrdinals.get(session) ?? 0) + 1;
        observedOrdinals.set(session, observedOrdinal);
        events.push({
          ...eventBase({
            eventId: EventId.makeUnsafe(randomUUID()),
            createdAt,
            threadId: session.threadId,
            sessionEpoch: session.sessionEpoch,
            ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
            raw: {
              source: "pi.rpc.event",
              messageType: "extension_ui_request",
              payload: { widgetKey: WIDGET_KEY, nodeId: nativeId },
            },
          }),
          type: "task.updated",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(
              `pi:${session.threadId}:${session.sessionEpoch}:async:${nativeId}`,
            ),
            kind: "providerSubagent",
            nativeId,
            activityFresh: status === "inProgress",
            status,
            subject: node.label,
            background: true,
            ...(parentId ? { parentAgentId: parentId } : {}),
            ...(node.activity?.currentTool ? { lastToolName: node.activity.currentTool } : {}),
            ...(node.activity?.toolCount !== undefined || node.activity?.turnCount !== undefined
              ? {
                  usage: {
                    ...(node.activity.toolCount !== undefined
                      ? { toolCalls: node.activity.toolCount }
                      : {}),
                    ...(node.activity.turnCount !== undefined
                      ? { turns: node.activity.turnCount }
                      : {}),
                  },
                }
              : {}),
            ...(node.state === "paused" || node.state === "partial" || node.state === "rejected"
              ? { terminalReason: node.state }
              : {}),
            source: "background",
            freshness: {
              sessionEpoch: String(session.sessionEpoch),
              sourcePriority: 3,
              providerRevision: generatedAt,
              providerTimestamp: createdAt,
              observedOrdinal,
            },
            createdAt: new Date(node.startedAt ?? generatedAt).toISOString(),
            ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
          },
        });
      }
    }
    if (visited >= MAX_AGENTS) return;
    for (const child of node.children ?? []) {
      visit(
        child,
        [...identity, encodeURIComponent(node.id)],
        node.kind === "workflow" ? parentId : nativeId,
      );
    }
  }

  for (const run of snapshot.runs) {
    visit(run, []);
    if (visited >= MAX_AGENTS) break;
  }
  for (const nativeId of prior.keys()) {
    if (seen.has(nativeId)) continue;
    prior.delete(nativeId);
    const observedOrdinal = (observedOrdinals.get(session) ?? 0) + 1;
    observedOrdinals.set(session, observedOrdinal);
    events.push({
      ...eventBase({
        eventId: EventId.makeUnsafe(randomUUID()),
        createdAt,
        threadId: session.threadId,
        sessionEpoch: session.sessionEpoch,
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
        raw: {
          source: "pi.rpc.event",
          messageType: "extension_ui_request",
          payload: { widgetKey: WIDGET_KEY, nodeId: nativeId, replacement: "snapshot" },
        },
      }),
      type: "task.removed",
      payload: {
        taskId: RuntimeTaskId.makeUnsafe(
          `pi:${session.threadId}:${session.sessionEpoch}:async:${nativeId}`,
        ),
        source: "background",
        replacement: "snapshot",
        freshness: {
          sessionEpoch: String(session.sessionEpoch),
          sourcePriority: 3,
          providerRevision: generatedAt,
          providerTimestamp: createdAt,
          observedOrdinal,
        },
      },
    });
  }
  return events;
}
