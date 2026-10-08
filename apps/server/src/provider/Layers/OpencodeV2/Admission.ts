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
import { admissionCorrelation } from "./Admission.identity.ts";

export class V2AdmissionUnconfirmed extends Schema.TaggedErrorClass<V2AdmissionUnconfirmed>()(
  "V2AdmissionUnconfirmed",
  { detail: Schema.String },
) {}

export type V2AdmissionError = ProviderTurnAdmissionError | V2AdmissionUnconfirmed;

export interface V2AdmissionRequest {
  readonly identity: ProviderTurnAdmissionIdentity;
  readonly binding: ProviderTurnAdmissionBinding;
  readonly fingerprint: string;
  readonly isCurrent: () => boolean;
  /** Native ack/observed projection must correlate exact session and admission material. */
  readonly dispatch: (row: ProviderTurnAdmission) => Effect.Effect<boolean, V2AdmissionUnconfirmed>;
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
    return yield* journal.transition(row, "accepted", new Date().toISOString());
  }
  row = yield* journal.transition(row, "dispatch-intent", new Date().toISOString());
  // Any failure after this durable write, including cancellation before RPC, stays uncertain.
  if (!request.isCurrent())
    return yield* Effect.fail(
      new V2AdmissionUnconfirmed({ detail: "Admission intent retained after ownership changed." }),
    );
  const accepted = yield* request.dispatch(row);
  if (!accepted || !request.isCurrent()) {
    return yield* Effect.fail(
      new V2AdmissionUnconfirmed({
        detail: "Native acknowledgement was uncorrelated or stale; dispatch will not be replayed.",
      }),
    );
  }
  return yield* journal.transition(row, "accepted", new Date().toISOString());
});
