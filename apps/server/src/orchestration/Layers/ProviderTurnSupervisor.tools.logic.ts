/**
 * Pure tool-in-flight evidence for sleep recovery, and the coordinator's own view of which
 * turn a thread is running.
 *
 * Two sources are combined, so the error is always towards asking:
 *
 * - The coordinator tracks tool items per thread from the provider runtime stream. That stream
 *   is lossless and never throttled, unlike the work-log rows.
 * - The thread's tool activities. The runtime activity governor suppresses work-log rows past
 *   its per-turn budget, so a later `tool.started` may never reach the read model. A
 *   suppressed `tool` row therefore counts as a tool in flight, unless the tracking saw the
 *   whole turn from its `turn.started`.
 *
 * @module ProviderTurnSupervisor.tools.logic
 */
import {
  isToolLifecycleItemType,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@bigbud/contracts";
import { ToolActivityPayload } from "@bigbud/contracts/orchestration/orchestration.toolActivity.ts";
import { Option, Schema } from "effect";

/** A tool that started and has not completed. */
export interface ToolInFlight {
  readonly itemId: string | null;
  readonly name: string;
}

/** How the prompt names a tool whose start was suppressed or not recorded. */
export const UNRECORDED_TOOL_LABEL = "a tool";
/** Bound on open tools tracked per turn; beyond it the list is marked incomplete. */
export const MAX_TRACKED_OPEN_TOOLS = 256;

/** The coordinator's in-memory view of one thread's current turn. */
export interface TurnToolTracking {
  turnId: TurnId | null;
  /** Began at the turn's `turn.started`, so every tool start of the turn passed through. */
  readonly fromTurnStart: boolean;
  /** When the provider started the turn (the `turn.started` event's own time), if seen. */
  readonly startedAtMs: number | null;
  /** The turn ended (`turn.completed` in any state, or `turn.aborted`). */
  ended: boolean;
  /** More tools were open than the bound; the list is incomplete. */
  overflowed: boolean;
  readonly open: Map<string, string>;
  readonly anonymous: string[];
}

function freshTracking(turnId: TurnId | null, startedAtMs: number | null): TurnToolTracking {
  return {
    turnId,
    fromTurnStart: startedAtMs !== null,
    startedAtMs,
    ended: false,
    overflowed: false,
    open: new Map(),
    anonymous: [],
  };
}

const sameTurn = (tracking: TurnToolTracking, turnId: TurnId | null | undefined) =>
  turnId == null || tracking.turnId === null || tracking.turnId === turnId;

function setTracking(
  trackingByThread: Map<ThreadId, TurnToolTracking>,
  threadId: ThreadId,
  tracking: TurnToolTracking,
  maxThreads: number,
): void {
  trackingByThread.delete(threadId);
  trackingByThread.set(threadId, tracking);
  while (trackingByThread.size > maxThreads) {
    const oldest = trackingByThread.keys().next();
    if (oldest.done) break;
    trackingByThread.delete(oldest.value);
  }
}

/** A `turn.started` event's own time; a malformed time still marks the turn as seen from start. */
const turnStartedAtMs = (event: ProviderRuntimeEvent) => {
  const atMs = Date.parse(event.createdAt);
  return Number.isFinite(atMs) ? atMs : 0;
};

/** Folds one provider runtime event into the thread's tracking. Other events are ignored. */
export function trackTurnToolEvent(
  trackingByThread: Map<ThreadId, TurnToolTracking>,
  event: ProviderRuntimeEvent,
  maxThreads: number,
): void {
  const current = trackingByThread.get(event.threadId);
  switch (event.type) {
    case "turn.started":
      setTracking(
        trackingByThread,
        event.threadId,
        freshTracking(event.turnId ?? null, turnStartedAtMs(event)),
        maxThreads,
      );
      return;
    case "turn.completed":
    case "turn.aborted":
      if (current && sameTurn(current, event.turnId)) current.ended = true;
      return;
    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) return;
      let tracking = current;
      if (!tracking || !sameTurn(tracking, event.turnId)) {
        tracking = freshTracking(event.turnId ?? null, null);
        setTracking(trackingByThread, event.threadId, tracking, maxThreads);
      }
      if (tracking.turnId === null && event.turnId) tracking.turnId = event.turnId;
      if (tracking.open.size + tracking.anonymous.length >= MAX_TRACKED_OPEN_TOOLS) {
        tracking.overflowed = true;
        return;
      }
      const name = event.payload.title?.trim() || "Tool";
      if (event.itemId) tracking.open.set(String(event.itemId), name);
      else tracking.anonymous.push(name);
      return;
    }
    case "item.completed":
      if (!isToolLifecycleItemType(event.payload.itemType)) return;
      if (!current || !sameTurn(current, event.turnId)) return;
      if (event.itemId) current.open.delete(String(event.itemId));
      else current.anonymous.shift();
      return;
    default:
      return;
  }
}

/** The tracking for `turnId`, or undefined when the coordinator did not see that turn. */
export function trackingForTurn(
  tracking: TurnToolTracking | undefined,
  turnId: TurnId | null,
): TurnToolTracking | undefined {
  if (!tracking) return undefined;
  if (turnId !== null && tracking.turnId !== null && tracking.turnId !== turnId) return undefined;
  return tracking;
}

function trackedTools(tracking: TurnToolTracking): ReadonlyArray<ToolInFlight> {
  return [
    ...Array.from(tracking.open, ([itemId, name]) => ({ itemId, name })),
    ...tracking.anonymous.map((name) => ({ itemId: null, name })),
    ...(tracking.overflowed ? [{ itemId: null, name: UNRECORDED_TOOL_LABEL }] : []),
  ];
}

const decodeToolActivityPayload = Schema.decodeUnknownOption(ToolActivityPayload);

/** The tool activity's item ID. Only `tool.*` rows are decoded, so the cost stays per tool row. */
function activityItemId(activity: OrchestrationThreadActivity): string | null {
  return Option.match(decodeToolActivityPayload(activity.payload), {
    onNone: () => null,
    onSome: (payload) => payload.itemId ?? null,
  });
}

function isSuppressedToolRow(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "runtime.activity.suppressed") return false;
  const payload = activity.payload;
  return (
    payload !== null &&
    typeof payload === "object" &&
    (payload as { readonly category?: unknown }).category === "tool"
  );
}

function toolName(activity: OrchestrationThreadActivity): string {
  return activity.summary.replace(/ started$/, "").trim() || "A tool";
}

/**
 * Whether an activity may belong to the turn. A tool activity without a turn ID may belong to
 * it, so it counts when it was created after the turn was requested (`since`).
 */
function inTurnScope(
  activity: OrchestrationThreadActivity,
  turnId: TurnId | null,
  sinceMs: number | null,
): boolean {
  if (turnId === null || activity.turnId === turnId) return true;
  if (activity.turnId !== null || sinceMs === null) return false;
  const createdAtMs = Date.parse(activity.createdAt);
  return Number.isFinite(createdAtMs) && createdAtMs >= sinceMs;
}

/**
 * Tools of `turnId` that started and have not completed, from the thread's activities. A
 * `tool.started` pairs with the `tool.completed` of the same `itemId`. Without an `itemId`,
 * completions are matched in order of start, and any unmatched start counts as in flight.
 * With `countSuppressed`, a suppressed `tool` row counts as one unrecorded tool in flight.
 */
export function findToolItemsInFlight(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null,
  options: { readonly since?: string | null; readonly countSuppressed?: boolean } = {},
): ReadonlyArray<ToolInFlight> {
  const sinceMs = options.since ? Date.parse(options.since) : Number.NaN;
  const scopeSinceMs = Number.isFinite(sinceMs) ? sinceMs : null;
  const open = new Map<string, OrchestrationThreadActivity>();
  const anonymous: OrchestrationThreadActivity[] = [];
  let suppressed = false;
  for (const activity of activities) {
    if (!inTurnScope(activity, turnId, scopeSinceMs)) continue;
    if (isSuppressedToolRow(activity)) {
      suppressed = true;
      continue;
    }
    if (activity.kind !== "tool.started" && activity.kind !== "tool.completed") continue;
    const itemId = activityItemId(activity);
    if (activity.kind === "tool.started") {
      if (itemId === null) anonymous.push(activity);
      else open.set(itemId, activity);
    } else if (itemId !== null) {
      open.delete(itemId);
    } else {
      anonymous.shift();
    }
  }
  return [
    ...Array.from(open, ([itemId, activity]) => ({ itemId, name: toolName(activity) })),
    ...anonymous.map((activity) => ({ itemId: null, name: toolName(activity) })),
    ...(suppressed && options.countSuppressed
      ? [{ itemId: null, name: UNRECORDED_TOOL_LABEL }]
      : []),
  ];
}

/** Union of two sources, deduplicated by item ID; anonymous starts keep the larger count. */
function mergeToolsInFlight(
  left: ReadonlyArray<ToolInFlight>,
  right: ReadonlyArray<ToolInFlight>,
): ReadonlyArray<ToolInFlight> {
  const byItem = new Map<string, ToolInFlight>();
  for (const tool of [...left, ...right]) {
    if (tool.itemId !== null && !byItem.has(tool.itemId)) byItem.set(tool.itemId, tool);
  }
  const leftAnonymous = left.filter((tool) => tool.itemId === null);
  const rightAnonymous = right.filter((tool) => tool.itemId === null);
  return [
    ...byItem.values(),
    ...(leftAnonymous.length >= rightAnonymous.length ? leftAnonymous : rightAnonymous),
  ];
}

/** Names of the tools that may have been running in the intent's turn. */
export function toolsInFlightForTurn(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly turnId: TurnId | null;
  /** When the turn was requested; scopes activities that carry no turn ID. */
  readonly since: string;
  readonly tracking: TurnToolTracking | undefined;
}): ReadonlyArray<string> {
  const tracking = trackingForTurn(input.tracking, input.turnId);
  const coversTurn = tracking !== undefined && tracking.fromTurnStart && !tracking.overflowed;
  const fromActivities = findToolItemsInFlight(input.activities, input.turnId, {
    since: input.since,
    countSuppressed: !coversTurn,
  });
  const merged = tracking
    ? mergeToolsInFlight(fromActivities, trackedTools(tracking))
    : fromActivities;
  return merged.map((tool) => tool.name);
}
