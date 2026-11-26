import type {
  ProviderTurnAdmission,
  ProviderTurnAdmissionBinding,
  ProviderTurnAdmissionIdentity,
} from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import { Effect, Schema } from "effect";

import {
  ProviderTurnAdmissions,
  type ProviderTurnAdmissionError,
} from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import { admissionCorrelation } from "./Admission.identity.ts";

export class V2AdmissionUnconfirmed extends Schema.TaggedErrorClass<V2AdmissionUnconfirmed>()(
  "V2AdmissionUnconfirmed",
  { detail: Schema.String },
) {}

/** Only preparation before durable dispatch intent may carry this classification. */
export class V2PreparationFailed extends Schema.TaggedErrorClass<V2PreparationFailed>()(
  "V2PreparationFailed",
  { detail: Schema.String },
) {}

export type V2AdmissionError =
  | ProviderTurnAdmissionError
  | V2AdmissionUnconfirmed
  | V2PreparationFailed
  | ProviderAdapterValidationError;

export interface V2AdmissionRequest {
  readonly identity: ProviderTurnAdmissionIdentity;
  readonly binding: ProviderTurnAdmissionBinding;
  readonly fingerprint: string;
  readonly isCurrent: () => boolean;
  /** Non-executing preparation may be retried only against the same immutable reservation. */
  readonly prepare?: (
    row: ProviderTurnAdmission,
  ) => Effect.Effect<
    void,
    V2AdmissionUnconfirmed | V2PreparationFailed | ProviderAdapterValidationError
  >;
  /** Native ack/observed projection must correlate exact session and admission material. */
  readonly dispatch: (
    row: ProviderTurnAdmission,
  ) => Effect.Effect<boolean, V2AdmissionUnconfirmed | ProviderAdapterValidationError>;
  readonly reconcile: (
    row: ProviderTurnAdmission,
  ) => Effect.Effect<"accepted" | "unknown", V2AdmissionUnconfirmed>;
}

/** Shared foreground/job boundary: every intent write precedes native dispatch. */
export const admitV2Turn = Effect.fn("admitV2Turn")(function* (request: V2AdmissionRequest) {
  if (
    request.binding.provider !== "opencodeV2" ||
    !request.binding.nativeSessionId.startsWith("ses_") ||
    (request.identity.namespace === "foreground" &&
      request.identity.ownerThreadId !== request.binding.threadId) ||
    (request.identity.namespace === "learning" &&
      request.binding.threadId === request.identity.ownerThreadId)
  ) {
    return yield* Effect.fail(
      new V2AdmissionUnconfirmed({
        detail: "V2 admission provider/namespace ownership rejected before dispatch.",
      }),
    );
  }
  const journal = yield* ProviderTurnAdmissions;
  // A reserve call is a new durable operation, not a read-only ownership observation.
  if (!request.isCurrent())
    return yield* new V2AdmissionUnconfirmed({
      detail: "Admission ownership fence is no longer current; no reservation was issued.",
    });
  let row = yield* journal.reserve({
    ...request.identity,
    binding: request.binding,
    fingerprint: request.fingerprint,
    ...admissionCorrelation(request.identity),
    createdAt: new Date().toISOString(),
  });
  if (!request.isCurrent())
    return yield* Effect.fail(
      new V2AdmissionUnconfirmed({ detail: "Admission ownership fence is no longer current." }),
    );
  if (row.state === "accepted" || row.state === "terminal") return row;
  if (row.state === "dispatch-intent") {
    const observed = yield* request.reconcile(row);
    if (observed !== "accepted" || !request.isCurrent()) {
      return yield* Effect.fail(
        new V2AdmissionUnconfirmed({
          detail:
            "Admission remains unconfirmed. No automatic resend is allowed; new work may duplicate execution.",
        }),
      );
    }
    const accepted = yield* journal.transition(row, "accepted", new Date().toISOString());
    if (!request.isCurrent())
      return yield* Effect.fail(
        new V2AdmissionUnconfirmed({
          detail: "Admission SQL result owner changed; no publication or resend.",
        }),
      );
    return accepted;
  }
  if (request.prepare) yield* request.prepare(row);
  if (!request.isCurrent())
    return yield* new V2AdmissionUnconfirmed({
      detail: "V2 preparation owner changed before prompt dispatch; reservation retained.",
    });
  row = yield* journal.transition(row, "dispatch-intent", new Date().toISOString());
  // Any failure after this durable write, including cancellation before RPC, stays uncertain.
  if (!request.isCurrent())
    return yield* Effect.fail(
      new V2AdmissionUnconfirmed({ detail: "Admission intent retained after ownership changed." }),
    );
  const dispatched = yield* request.dispatch(row).pipe(Effect.result);
  if (dispatched._tag === "Failure") {
    const error = dispatched.failure;
    if (
      Schema.is(ProviderAdapterValidationError)(error) &&
      error.operation === "sendTurn" &&
      error.turnStartRefusal?.gate.provider === "opencodeV2"
    ) {
      if (!request.isCurrent())
        return yield* new V2AdmissionUnconfirmed({
          detail: "Local refusal lost ownership of its exact intent; no resend.",
        });
      if (error.turnStartRefusal.gate.manualRecovery) {
        // No same-ID replay is allowed for a manual-recovery hold.
        yield* journal.settleProvenRefusal(row, new Date().toISOString());
      } else {
        if (!journal.reopenUndispatchedIntent)
          return yield* new V2AdmissionUnconfirmed({
            detail: "Local refusal could not reopen its exact intent; no resend.",
          });
        yield* journal.reopenUndispatchedIntent(row, new Date().toISOString());
      }
    }
    return yield* error;
  }
  if (!dispatched.success || !request.isCurrent()) {
    return yield* Effect.fail(
      new V2AdmissionUnconfirmed({
        detail: "Native acknowledgement was uncorrelated or stale; dispatch will not be replayed.",
      }),
    );
  }
  const result = yield* journal.transition(row, "accepted", new Date().toISOString());
  if (!request.isCurrent())
    return yield* Effect.fail(
      new V2AdmissionUnconfirmed({
        detail: "Admission SQL result owner changed; no publication or resend.",
      }),
    );
  return result;
});
