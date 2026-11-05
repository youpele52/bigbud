import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import { Effect } from "effect";

import type { ProviderTurnAdmissionsShape } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { mapMuseRequestError, museRequestError } from "./Client.errors.ts";

/** Immutable identity/material must agree before accepting a concurrent writer's progress. */
function sameMaterial(a: ProviderTurnAdmission, b: ProviderTurnAdmission): boolean {
  return (
    a.namespace === b.namespace &&
    a.ownerThreadId === b.ownerThreadId &&
    a.requestMessageId === b.requestMessageId &&
    a.fingerprint === b.fingerprint &&
    a.nativeAdmissionId === b.nativeAdmissionId &&
    a.turnId === b.turnId &&
    a.createdAt === b.createdAt &&
    (Object.keys(a.binding) as Array<keyof typeof a.binding>).every(
      (key) => a.binding[key] === b.binding[key],
    )
  );
}

/** Bounded CAS reconciliation only: this helper never redispatches native work. */
export const advanceMuseJournal = Effect.fn("Muse.advanceJournal")(function* (
  admissions: ProviderTurnAdmissionsShape,
  row: ProviderTurnAdmission,
  target: "accepted" | "terminal" | "refused",
  outcome?: ProviderTurnAdmission["terminalOutcome"],
) {
  let current = row;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (current.state === "terminal" || (target === "accepted" && current.state === "accepted"))
      return current;
    const next =
      target === "refused"
        ? "terminal"
        : current.state === "dispatch-intent"
          ? "accepted"
          : "terminal";
    if (
      current.state === "reserved" ||
      (target === "refused" && current.state !== "dispatch-intent")
    )
      return yield* museRequestError(
        "admissions.transition",
        "Unexpected admission state; journal was not reopened.",
        "unsafe-to-replay",
      );
    const result = yield* (
      target === "refused"
        ? admissions.settleProvenRefusal(current, new Date().toISOString())
        : admissions.transition(
            current,
            next,
            new Date().toISOString(),
            undefined,
            next === "terminal" ? outcome : undefined,
          )
    ).pipe(Effect.result);
    if (result._tag === "Success") {
      current = result.success;
      continue;
    }
    if (result.failure._tag !== "ProviderTurnAdmissionConflict")
      return yield* mapMuseRequestError(
        "admissions.transition",
        result.failure,
        "unsafe-to-replay",
      );
    const fresh = yield* admissions
      .find(row)
      .pipe(
        Effect.mapError((cause) =>
          mapMuseRequestError("admissions.find", cause, "unsafe-to-replay"),
        ),
      );
    if (!fresh || !sameMaterial(row, fresh) || fresh.revision < current.revision)
      return yield* mapMuseRequestError(
        "admissions.transition",
        result.failure,
        "unsafe-to-replay",
      );
    current = fresh;
  }
  return yield* museRequestError(
    "admissions.transition",
    "Concurrent journal updates exceeded the bounded reconciliation limit.",
    "unsafe-to-replay",
  );
});

/** Authoritative terminal evidence first admits an ack-loss row, then durably settles it. */
export function settleMuseJournalTerminal(
  admissions: ProviderTurnAdmissionsShape,
  row: ProviderTurnAdmission,
  outcome: "completed" | "failed" | "interrupted",
) {
  return advanceMuseJournal(admissions, row, "terminal", outcome);
}
