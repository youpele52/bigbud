import type {
  MarkerLine,
  OrchestrationEventRow,
  ProviderLogLine,
  SleepWakeRunRow,
  SleepWindow,
  TurnOutcome,
} from "./sleep-wake-probe.types.ts";

/** A running turn with no progress for this long after wake is reported as hung. */
export const HANG_THRESHOLD_MS = 120_000;

/** Marker lines this long before the probe started belong to an earlier run. */
const MARKER_START_SLACK_MS = 5_000;

const MAX_EVIDENCE = 6;
const EVIDENCE_TEXT_MAX = 160;

const NON_TERMINAL_SESSION = new Set(["starting", "running"]);
const ERROR_SESSION = new Set(["error", "interrupted"]);

/** Activity text that suggests the provider or bigbud retried or recovered after wake. */
const RETRY_TEXT =
  /retry|retrying|reconnect|resum|recover|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|EPIPE|EAI_AGAIN|ENOTFOUND/i;
/** Narrower match for raw provider logs, which also contain model text. */
const RETRY_LOG =
  /"(?:method|type|subtype|kind)":"[^"]*(?:retry|reconnect|resum|recover|error)[^"]*"|api_retry|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|EPIPE|EAI_AGAIN|ENOTFOUND/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clip(value: string): string {
  return value.length > EVIDENCE_TEXT_MAX ? `${value.slice(0, EVIDENCE_TEXT_MAX - 1)}…` : value;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export interface TurnSelection {
  readonly threadId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
}

/** The thread under test: the one named on the command line, else the first turn started. */
export function selectTurn(
  events: ReadonlyArray<OrchestrationEventRow>,
  threadId: string | null,
): TurnSelection {
  const start = events.find(
    (event) =>
      event.eventType === "thread.turn-start-requested" &&
      (threadId === null || event.streamId === threadId),
  );
  const selection = field(start?.payload, "modelSelection");
  return {
    threadId: threadId ?? start?.streamId ?? null,
    provider: text(field(selection, "provider")),
    model: text(field(selection, "model")),
  };
}

function isProgress(event: OrchestrationEventRow): boolean {
  if (event.eventType === "thread.message-sent")
    return field(event.payload, "role") === "assistant";
  if (event.eventType !== "thread.activity-appended") return false;
  return field(event.payload, "activity", "tone") !== "error";
}

function isErrorEvent(event: OrchestrationEventRow): boolean {
  if (event.eventType === "thread.turn-start-failed") return true;
  if (event.eventType !== "thread.session-set") return false;
  return ERROR_SESSION.has(String(field(event.payload, "session", "status")));
}

function isTerminal(event: OrchestrationEventRow, sawRunning: boolean): boolean {
  if (event.eventType === "thread.turn-start-failed") return true;
  if (event.eventType !== "thread.session-set" || !sawRunning) return false;
  return !NON_TERMINAL_SESSION.has(String(field(event.payload, "session", "status")));
}

function retryEvidence(
  events: ReadonlyArray<OrchestrationEventRow>,
  providerLog: ReadonlyArray<ProviderLogLine>,
  wokeAtMs: number,
): string[] {
  const found: string[] = [];
  for (const event of events) {
    if (event.occurredAtMs < wokeAtMs || event.eventType !== "thread.activity-appended") continue;
    const kind = String(field(event.payload, "activity", "kind"));
    const summary = text(field(event.payload, "activity", "summary")) ?? "";
    const message = text(field(event.payload, "activity", "payload", "message")) ?? "";
    const combined = `${summary} ${message}`;
    if (kind === "provider.session.recovery" || RETRY_TEXT.test(combined)) {
      found.push(clip(`activity ${kind}: ${combined.trim()}`));
    }
  }
  for (const line of providerLog) {
    if (line.atMs < wokeAtMs || !RETRY_LOG.test(line.text)) continue;
    found.push(clip(`provider log ${line.channel}: ${line.text}`));
  }
  return found.slice(0, MAX_EVIDENCE);
}

export interface TurnAnalysisInput {
  readonly events: ReadonlyArray<OrchestrationEventRow>;
  readonly threadId: string | null;
  readonly window: SleepWindow | null;
  readonly providerLog: ReadonlyArray<ProviderLogLine>;
  readonly marker: ReadonlyArray<MarkerLine> | null;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  /** False for remote runs, whose marker timestamps come from the remote clock. */
  readonly filterMarkerByTime: boolean;
}

export interface TurnAnalysis {
  readonly turnId: string | null;
  readonly turn: SleepWakeRunRow["turn"];
  readonly tools: SleepWakeRunRow["tools"];
}

function classify(input: {
  readonly terminal: OrchestrationEventRow | null;
  readonly window: SleepWindow | null;
  readonly errored: boolean;
  readonly retries: number;
  readonly lastProgressMs: number | null;
  readonly finishedAtMs: number;
}): TurnOutcome {
  const { terminal, window } = input;
  if (window === null) return "no-sleep";
  if (terminal !== null) {
    if (terminal.occurredAtMs < window.sleptAtMs) return "finished-before-sleep";
    if (input.errored) return "errored";
    if (terminal.occurredAtMs < window.wokeAtMs) return "finished-during-sleep";
    return input.retries > 0 ? "retried-internally" : "continued";
  }
  const quietSince = Math.max(input.lastProgressMs ?? 0, window.wokeAtMs);
  return input.finishedAtMs - quietSince >= HANG_THRESHOLD_MS ? "hung" : "still-running";
}

/** Classifies what the turn did across the sleep, and counts tool runs. */
export function analyzeTurn(input: TurnAnalysisInput): TurnAnalysis {
  const threadEvents = input.events.filter((event) => event.streamId === input.threadId);
  const emptyTools = {
    started: 0,
    completed: 0,
    markerStarts: null,
    markerDones: null,
    ranTwice: null,
  };
  if (input.threadId === null || threadEvents.length === 0) {
    // Without a sleep the run is invalid whatever the turn did, so `no-sleep` wins.
    const outcome: TurnOutcome = input.window === null ? "no-sleep" : "no-turn";
    const turn = {
      outcome,
      startedAt: null,
      endedAt: null,
      firstProgressAfterWakeMs: null,
      endedAfterWakeMs: null,
      lastSessionStatus: null,
      lastError: null,
      retryEvidence: [],
    };
    return { turnId: null, turn, tools: { ...emptyTools, ...markerCounts(input) } };
  }

  let turnId: string | null = null;
  let startedAtMs: number | null = null;
  let terminal: OrchestrationEventRow | null = null;
  let lastStatus: string | null = null;
  let lastError: string | null = null;
  let errored = false;
  for (const event of threadEvents) {
    if (event.eventType === "thread.session-set") {
      lastStatus = text(field(event.payload, "session", "status")) ?? lastStatus;
      lastError = text(field(event.payload, "session", "lastError")) ?? lastError;
      const active = text(field(event.payload, "session", "activeTurnId"));
      if (turnId === null && lastStatus === "running" && active !== null) {
        turnId = active;
        startedAtMs = event.occurredAtMs;
        continue;
      }
    }
    if (event.eventType === "thread.turn-start-failed") {
      lastError = text(field(event.payload, "detail")) ?? lastError;
    }
    if (isTerminal(event, turnId !== null)) {
      terminal = event;
      errored = isErrorEvent(event);
      break;
    }
  }

  // Later turns in the same thread are not part of this run.
  const scoped =
    terminal === null
      ? threadEvents
      : threadEvents.filter((event) => event.sequence <= terminal!.sequence);
  const wokeAtMs = input.window?.wokeAtMs ?? null;
  const progress = scoped.filter(isProgress);
  const afterWake =
    wokeAtMs === null ? [] : progress.filter((event) => event.occurredAtMs >= wokeAtMs);
  const lastProgressMs = progress.at(-1)?.occurredAtMs ?? null;
  const logUntil = terminal?.occurredAtMs ?? Number.POSITIVE_INFINITY;
  const evidence =
    wokeAtMs === null
      ? []
      : retryEvidence(
          scoped,
          input.providerLog.filter((line) => line.atMs <= logUntil),
          wokeAtMs,
        );
  const outcome = classify({
    terminal,
    window: input.window,
    errored,
    retries: evidence.length,
    lastProgressMs,
    finishedAtMs: input.finishedAtMs,
  });

  const toolKinds = (kind: string) =>
    scoped.filter(
      (event) =>
        event.eventType === "thread.activity-appended" &&
        field(event.payload, "activity", "kind") === kind &&
        (turnId === null || field(event.payload, "activity", "turnId") === turnId),
    ).length;

  return {
    turnId,
    turn: {
      outcome,
      startedAt: iso(startedAtMs),
      endedAt: iso(terminal?.occurredAtMs ?? null),
      firstProgressAfterWakeMs:
        wokeAtMs === null || afterWake[0] === undefined
          ? null
          : afterWake[0].occurredAtMs - wokeAtMs,
      endedAfterWakeMs:
        wokeAtMs === null || terminal === null || terminal.occurredAtMs < wokeAtMs
          ? null
          : terminal.occurredAtMs - wokeAtMs,
      lastSessionStatus: lastStatus,
      lastError,
      retryEvidence: evidence,
    },
    tools: {
      started: toolKinds("tool.started"),
      completed: toolKinds("tool.completed"),
      ...markerCounts(input),
    },
  };
}

function markerCounts(
  input: TurnAnalysisInput,
): Pick<SleepWakeRunRow["tools"], "markerStarts" | "markerDones" | "ranTwice"> {
  if (input.marker === null) return { markerStarts: null, markerDones: null, ranTwice: null };
  const inRun = input.filterMarkerByTime
    ? input.marker.filter((line) => line.atMs >= input.startedAtMs - MARKER_START_SLACK_MS)
    : input.marker;
  const starts = inRun.filter((line) => line.kind === "start").length;
  return {
    markerStarts: starts,
    markerDones: inRun.filter((line) => line.kind === "done").length,
    ranTwice: starts > 1,
  };
}
