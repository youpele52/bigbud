/**
 * Pure classification for sleep and wake recovery: which observations end a turn, whether a
 * tool may still be in flight, and whether a failure belongs to a sleep.
 *
 * @module ProviderTurnSupervisor.classify.logic
 */
import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";

import type { ThreadRecoveryIntent } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import {
  findToolItemsInFlight,
  type TurnToolTracking,
} from "./ProviderTurnSupervisor.tools.logic.ts";

export type TurnFailureKind =
  | "runtime-error"
  | "turn-failed"
  | "turn-aborted"
  | "session-exited"
  | "session-error"
  | "session-stopped";

/** A terminal failure of a running turn, as observed by the coordinator. */
export interface TurnFailureObservation {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly kind: TurnFailureKind;
  readonly observedAtMs: number;
  readonly detail: string | null;
}

/**
 * Provider wording that itself says the machine slept, for example Claude Code's "Connection
 * lost while your computer was asleep". Only phrases about the machine sleeping count: a
 * generic "suspended" (an account, a subscription) must never look like a sleep.
 */
const PROVIDER_SLEEP_LABELS = [
  /\b(?:computer|machine|system|device|laptop) (?:was asleep|was sleeping|went to sleep)\b/i,
];

export function hasProviderSleepLabel(detail: string | null | undefined): boolean {
  return detail != null && PROVIDER_SLEEP_LABELS.some((pattern) => pattern.test(detail));
}

/** Runtime events that end a running turn without completing it. */
export function failureFromRuntimeEvent(
  event: ProviderRuntimeEvent,
  observedAtMs: number,
): TurnFailureObservation | null {
  const base = { threadId: event.threadId, turnId: event.turnId ?? null, observedAtMs };
  switch (event.type) {
    case "runtime.error":
      return { ...base, kind: "runtime-error", detail: event.payload.message };
    case "turn.completed":
      return event.payload.state === "failed"
        ? { ...base, kind: "turn-failed", detail: event.payload.errorMessage ?? null }
        : null;
    case "turn.aborted":
      return { ...base, kind: "turn-aborted", detail: event.payload.reason };
    case "session.exited":
      return { ...base, kind: "session-exited", detail: event.payload.reason ?? null };
    default:
      return null;
  }
}

/** A completed (not failed) turn. */
export function isCompletedTurnEvent(event: ProviderRuntimeEvent): boolean {
  return event.type === "turn.completed" && event.payload.state === "completed";
}

/**
 * Progress that shows the provider is working again. `session.state.changed` is excluded: a
 * failure itself changes the session state.
 */
const PROGRESS_EVENT_TYPES = new Set<ProviderRuntimeEvent["type"]>([
  "turn.plan.updated",
  "turn.proposed.delta",
  "turn.diff.updated",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "user-input.requested",
  "task.progress",
  "tool.progress",
  "tool.summary",
]);

export function isProgressEvent(event: ProviderRuntimeEvent): boolean {
  return PROGRESS_EVENT_TYPES.has(event.type);
}

/** Orchestration session transitions that end a turn: `error`, or `stopped` with a turn bound. */
export function failureFromDomainEvent(
  event: OrchestrationEvent,
  observedAtMs: number,
): TurnFailureObservation | null {
  if (event.type !== "thread.session-set") return null;
  const session = event.payload.session;
  if (session.status !== "error" && session.status !== "stopped") return null;
  return {
    threadId: event.payload.threadId,
    turnId: session.activeTurnId ?? null,
    kind: session.status === "error" ? "session-error" : "session-stopped",
    observedAtMs,
    detail: session.lastError ?? null,
  };
}

/** Whether `observation` is about `intent`'s turn. Unbound intents match any turn. */
export function observationMatchesIntent(
  observation: TurnFailureObservation,
  intent: ThreadRecoveryIntent,
): boolean {
  if (observation.threadId !== intent.threadId) return false;
  return (
    observation.turnId === null || intent.turnId === null || observation.turnId === intent.turnId
  );
}

/**
 * Whether a completed `turnId` is the intent's own turn. A bound intent matches its turn. An
 * unbound intent matches only a turn the coordinator saw start after the intent was accepted,
 * and a continuation never does. The coordinator reads the runtime stream apart from
 * ingestion, so the previous turn's completion can arrive after a newer intent (a queued
 * prompt, a seeded continuation) was recorded. Settling that intent would also stop its own
 * turn from ever binding.
 */
export function completionBelongsToIntent(
  intent: ThreadRecoveryIntent,
  turnId: TurnId | null,
  tracking: TurnToolTracking | undefined,
): boolean {
  if (intent.turnId !== null) return turnId === null || turnId === intent.turnId;
  if (turnId === null || intent.detail.continuationOf !== undefined) return false;
  return (
    tracking?.turnId === turnId &&
    tracking.startedAtMs !== null &&
    tracking.startedAtMs >= Date.parse(intent.createdAt)
  );
}

/** Failures that end the turn. A runtime or session error may leave the turn running. */
export const TURN_ENDING_FAILURE_KINDS: ReadonlySet<TurnFailureKind> = new Set([
  "turn-failed",
  "turn-aborted",
  "session-exited",
  "session-stopped",
]);

/** A turn the provider ended as interrupted or cancelled. It is never continued. */
export function isTurnEndedWithoutCompletion(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "turn.completed" &&
    (event.payload.state === "interrupted" || event.payload.state === "cancelled")
  );
}

/** What is known about whether an intent's turn was running when a failure was observed. */
export interface TurnRunningEvidence {
  /** The thread session's active turn, when its status is `starting` or `running`. */
  readonly runningActiveTurnId: TurnId | null;
  /** Message of the thread's pending turn start, if one is open. */
  readonly pendingStartMessageId: string | null;
  /** The coordinator's own tracking: true or false when it saw the turn, null otherwise. */
  readonly trackedRunning: boolean | null;
  /** An active liveness row exists for the intent's turn. */
  readonly livenessActive: boolean;
}

/**
 * Only a failure of a turn that was actually running can be a sleep cut. A bound intent's
 * turn was running when the observation names it, or when the thread, the coordinator's
 * tracking or a liveness row says it still runs. An unbound intent counts only while its own
 * turn start is pending. A late failure on an idle thread therefore never resurrects an old
 * intent.
 */
export function intentTurnWasRunning(
  intent: ThreadRecoveryIntent,
  observation: TurnFailureObservation,
  evidence: TurnRunningEvidence,
): boolean {
  if (!observationMatchesIntent(observation, intent)) return false;
  if (intent.turnId === null) return evidence.pendingStartMessageId === intent.messageId;
  if (observation.turnId === intent.turnId) return true;
  if (evidence.runningActiveTurnId === intent.turnId) return true;
  if (evidence.trackedRunning !== null) return evidence.trackedRunning;
  return evidence.livenessActive;
}

export type FailureClassification = "interrupted-by-sleep" | "ordinary";

/**
 * A failure of an active intent's turn is a sleep cut when it falls inside a sleep window,
 * or when the provider's own message says the machine slept. Anything else keeps today's
 * behavior.
 */
export function classifyTurnFailure(input: {
  readonly intent: ThreadRecoveryIntent;
  readonly observation: TurnFailureObservation;
  readonly inSleepWindow: boolean;
}): FailureClassification {
  if (input.intent.disposition !== "active") return "ordinary";
  if (!observationMatchesIntent(input.observation, input.intent)) return "ordinary";
  if (input.inSleepWindow || hasProviderSleepLabel(input.observation.detail)) {
    return "interrupted-by-sleep";
  }
  return "ordinary";
}

/** Names of the tools of `turnId` that started and have not completed, from activities. */
export function findToolsInFlight(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null,
): ReadonlyArray<string> {
  return findToolItemsInFlight(activities, turnId).map((tool) => tool.name);
}

/** How the prompt names a remote-agent shell command whose outcome is uncertain. */
export const REMOTE_SHELL_TOOL_LABEL = "Remote shell command";

/** One line naming the in-flight tool(s) for the prompt, or null when none. */
export function summarizeToolsInFlight(tools: ReadonlyArray<string>): string | null {
  if (tools.length === 0) return null;
  const [first, ...rest] = tools;
  return rest.length === 0 ? first! : `${first} and ${rest.length} more`;
}
