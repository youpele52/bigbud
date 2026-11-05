import type { ProviderRuntimeEvent, ThreadId, TurnId } from "@bigbud/contracts";
import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import { Effect } from "effect";

import type { ProviderTurnAdmissionsShape } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { mapMuseRequestError, museRequestError } from "./Client.errors.ts";
import { mapTerminalState } from "./Adapter.stream.turns.ts";
import { settleMuseJournalTerminal } from "./Adapter.journal.ts";
export { settleMuseJournalTerminal } from "./Adapter.journal.ts";

const mapJournalError = (method: string) =>
  Effect.mapError((error: { message: string }) =>
    mapMuseRequestError(method, error, "unsafe-to-replay"),
  );

/** Complete immutable-key scan, including terminal canonical-delivery evidence. */
export interface MuseJournalScan {
  readonly rows: ReadonlyArray<ProviderTurnAdmission>;
  readonly pagesScanned: number;
}

/**
 * Page through every bound Muse journal row for a thread with the
 * repository's immutable continuation key. Terminal rows are included
 * (canonical-delivery evidence), not only unresolved ones; unrelated
 * owners cannot starve the scan, and no single `latestBound` row or
 * first page is treated as proof of completeness.
 */
export function scanMuseJournal(
  admissions: ProviderTurnAdmissionsShape,
  threadId: ThreadId,
  pageSize = 100,
) {
  return Effect.gen(function* () {
    const rows: Array<ProviderTurnAdmission> = [];
    let pagesScanned = 0;
    let after:
      | Pick<
          ProviderTurnAdmission,
          "createdAt" | "namespace" | "ownerThreadId" | "requestMessageId"
        >
      | undefined;
    while (true) {
      const page = yield* admissions
        .listBoundPage({ threadId, limit: pageSize, ...(after ? { after } : {}) })
        .pipe(mapJournalError("admissions.listBoundPage"));
      pagesScanned += 1;
      rows.push(...page);
      const last = page.at(-1);
      if (!last || page.length < pageSize) break;
      after = {
        createdAt: last.createdAt,
        namespace: last.namespace,
        ownerThreadId: last.ownerThreadId,
        requestMessageId: last.requestMessageId,
      };
    }
    return { rows, pagesScanned } satisfies MuseJournalScan;
  });
}

/** Native evidence available after an exact-ID resume (session/resume + session/read). */
export interface MuseNativeRecoveryEvidence {
  readonly activeTurnId?: string | null;
  readonly queuedTurnIds?: ReadonlyArray<string>;
  readonly lastTurn?: { readonly turnId: string; readonly terminal: string } | null;
}

export type MuseRecoveryAction =
  | { readonly kind: "still-active"; readonly row: ProviderTurnAdmission }
  | { readonly kind: "still-queued"; readonly row: ProviderTurnAdmission }
  | {
      readonly kind: "settle-terminal";
      readonly row: ProviderTurnAdmission;
      readonly outcome: "completed" | "failed" | "interrupted";
    }
  | { readonly kind: "uncertain"; readonly row: ProviderTurnAdmission }
  | { readonly kind: "terminal-evidence"; readonly row: ProviderTurnAdmission }
  | { readonly kind: "redeliver-terminal"; readonly row: ProviderTurnAdmission };

/**
 * Pure recovery plan for scanned Muse rows. Absence from the native queue or
 * active slot is never treated as settlement evidence: only the native
 * `lastTurn` terminal record can settle an unresolved row. Terminal rows
 * are evidence; only the row matching the native last turn (the plausible
 * crash window for the latest work) is a redelivery candidate.
 */
export function planMuseRecovery(
  rows: ReadonlyArray<ProviderTurnAdmission>,
  evidence: MuseNativeRecoveryEvidence,
): ReadonlyArray<MuseRecoveryAction> {
  const queued = new Set(evidence.queuedTurnIds ?? []);
  return rows.map((row) => {
    if (row.state === "terminal") {
      return row.terminalOutcome && evidence.lastTurn && row.turnId === evidence.lastTurn.turnId
        ? { kind: "redeliver-terminal", row }
        : { kind: "terminal-evidence", row };
    }
    if (evidence.activeTurnId && row.turnId === evidence.activeTurnId) {
      return { kind: "still-active", row };
    }
    if (queued.has(row.turnId)) return { kind: "still-queued", row };
    if (evidence.lastTurn && row.turnId === evidence.lastTurn.turnId) {
      return {
        kind: "settle-terminal",
        row,
        outcome: mapTerminalState(evidence.lastTurn.terminal),
      };
    }
    return { kind: "uncertain", row };
  });
}

/**
 * The narrow canonical recovery-delivery event for a terminal journal row
 * whose canonical outcome may never have been delivered (crash after
 * journal settlement, after the shared-liveness claim, or after stream
 * publication but before canonical application). The event ID is stable
 * per native turn, so repeated recovery stays idempotent under canonical
 * deduplication; the terminal outcome is never changed or reopened.
 */
export function museRecoveryTerminalEvent(
  threadId: ThreadId,
  row: ProviderTurnAdmission,
): ProviderRuntimeEvent {
  if (row.state !== "terminal" || row.terminalOutcome === undefined)
    throw museRequestError(
      "admissions.recovery",
      "Journal row does not carry a durable terminal outcome.",
      "unsafe-to-replay",
    );
  return {
    eventId: `muse-recovery-terminal-${row.turnId}`,
    provider: "muse",
    threadId,
    createdAt: row.updatedAt,
    turnId: row.turnId as TurnId,
    type: "turn.completed",
    payload: {
      state:
        row.terminalOutcome === "failed"
          ? "failed"
          : row.terminalOutcome === "interrupted"
            ? "interrupted"
            : "completed",
      recoveryRedelivery: true,
    },
  } as ProviderRuntimeEvent;
}

export interface MuseRecoveryReport {
  readonly pagesScanned: number;
  readonly settled: number;
  readonly stillActive: number;
  readonly stillQueued: number;
  readonly uncertain: number;
  readonly terminalEvidence: number;
  readonly redelivered: number;
}

/**
 * Execute a recovery plan: settle only rows with authoritative native
 * terminal evidence, republish only redelivery candidates, and leave every
 * other unresolved row untouched (never resubmitted, never inferred).
 */
export function executeMuseRecovery(input: {
  readonly admissions: ProviderTurnAdmissionsShape;
  readonly threadId: ThreadId;
  readonly scan: MuseJournalScan;
  readonly evidence: MuseNativeRecoveryEvidence;
  readonly publish: (event: ProviderRuntimeEvent) => Effect.Effect<unknown>;
}) {
  return Effect.gen(function* () {
    const actions = planMuseRecovery(input.scan.rows, input.evidence);
    const counts = {
      settled: 0,
      stillActive: 0,
      stillQueued: 0,
      uncertain: 0,
      terminalEvidence: 0,
      redelivered: 0,
    };
    for (const action of actions) {
      switch (action.kind) {
        case "settle-terminal": {
          const settled = yield* settleMuseJournalTerminal(
            input.admissions,
            action.row,
            action.outcome,
          );
          counts.settled += 1;
          // A settlement made during this recovery may also have missed
          // canonical delivery in the same crash; republish it stably.
          const event = yield* Effect.try({
            try: () => museRecoveryTerminalEvent(input.threadId, settled),
            catch: (cause) => mapMuseRequestError("admissions.recovery", cause, "unsafe-to-replay"),
          });
          yield* input.publish(event);
          counts.redelivered += 1;
          break;
        }
        case "redeliver-terminal": {
          const event = yield* Effect.try({
            try: () => museRecoveryTerminalEvent(input.threadId, action.row),
            catch: (cause) => mapMuseRequestError("admissions.recovery", cause, "unsafe-to-replay"),
          });
          yield* input.publish(event);
          counts.redelivered += 1;
          break;
        }
        case "still-active":
          counts.stillActive += 1;
          break;
        case "still-queued":
          counts.stillQueued += 1;
          break;
        case "terminal-evidence":
          counts.terminalEvidence += 1;
          break;
        case "uncertain":
          counts.uncertain += 1;
          break;
      }
    }
    return { pagesScanned: input.scan.pagesScanned, ...counts } satisfies MuseRecoveryReport;
  });
}
