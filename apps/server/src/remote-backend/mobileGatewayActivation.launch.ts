import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { MobileGatewayConfiguration } from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { acquireMobileGatewayActivationAuthority } from "./mobileGatewayActivation.authority.ts";
import type { RemoteMobileNativeInputsValue } from "./mobileGatewayActivation.inputs.ts";
import {
  verifiedNativeMobilePublication,
  withNativeMobilePublication,
} from "./mobileGatewayActivation.publication.ts";
import { commitMobileGatewayDesiredSelection } from "./mobileGatewayActivation.selection.ts";
import {
  runNativeMobileGatewaySession,
  type NativeMobileGatewaySessionSignals,
} from "./mobileGatewayNative.session.ts";
import {
  classifyMobileActivationCause,
  type MobileActivationReason,
} from "./mobileGatewayActivation.reason.ts";
import { mobileStageIdForConsent } from "./mobileGatewayActivation.stage.ts";

export interface NativeMobileActivationRequest {
  readonly requestId: string;
  readonly configuration: MobileGatewayConfiguration;
}
/**
 * Honest settlement of one activation. `failed` before `onSelected` never reached native Start;
 * after it, `repairRequired` means original native ownership is uncertain (keep intent/pin/assets).
 */
export type NativeMobileActivationOutcome =
  | { readonly kind: "unavailable" }
  | { readonly kind: "disabled" }
  | { readonly kind: "exit-recorded" }
  | { readonly kind: "detached" }
  | {
      readonly kind: "failed";
      readonly repairRequired: boolean;
      readonly cause: unknown;
      /** Fixed step that failed; absent means classify the cause by its error names. */
      readonly reason?: MobileActivationReason;
    };

const failed = (
  cause: unknown,
  repairRequired: boolean,
  reason: MobileActivationReason,
): NativeMobileActivationOutcome => ({ kind: "failed", repairRequired, cause, reason });

/**
 * One activation, owned by the attached controller: activation authority → durable consent read
 * → publish/remint (held for the session's lifetime) → desired-selection CAS → `onSelected` →
 * native session. Never fails: every settlement is an outcome the controller maps to state.
 */
export const runNativeMobileActivation = Effect.fn("runNativeMobileActivation")(function* (
  inputs: RemoteMobileNativeInputsValue,
  request: NativeMobileActivationRequest,
  signals: NativeMobileGatewaySessionSignals,
  onSelected: () => void,
) {
  const authority = yield* Effect.exit(acquireMobileGatewayActivationAuthority);
  if (Exit.isFailure(authority)) return { kind: "unavailable" } as NativeMobileActivationOutcome;
  const retired = AbortSignal.any([signals.detach, signals.stop]);
  const journal = yield* Effect.exit(
    Effect.tryPromise((signal) =>
      authority.value.registry(AbortSignal.any([signal, retired])).read(),
    ),
  );
  if (Exit.isFailure(journal)) return failed(journal.cause, false, "journal-unreadable");
  const state = journal.value;
  if (state.schemaVersion !== 3 || !state.mobile.consent.enabled)
    return { kind: "disabled" } as NativeMobileActivationOutcome;
  const consentRevision = state.mobile.consent.revision;
  // A consent change fences the inputs' stage; a new grant publishes its own stage.
  const stageId = mobileStageIdForConsent(state.mobile, inputs.artifacts.stageId, consentRevision);
  const published = state.mobile.stages.some(
    (stage) =>
      stage.id === stageId &&
      stage.consentRevision === consentRevision &&
      stage.phase === "files-published",
  );
  const run = Effect.runPromiseWith(
    yield* Effect.services<
      Effect.Services<ReturnType<typeof runNativeMobileGatewaySession>> | SelectionServices
    >(),
  );
  let selected = false;
  let step: "publication-failed" | "selection-failed" = "publication-failed";
  const settled = yield* Effect.exit(
    withNativeMobilePublication(
      inputs.trustedKeys,
      retired,
      (publisher, signal) =>
        verifiedNativeMobilePublication(
          publisher,
          inputs,
          stageId,
          consentRevision,
          published,
          signal,
        ),
      async (proof, lifetime, signal) => {
        step = "selection-failed";
        await run(
          commitMobileGatewayDesiredSelection(proof, request.requestId, request.configuration),
          { signal },
        );
        selected = true;
        onSelected();
        // Losing the publication lifetime hands the child to a successor; it never kills it.
        return run(
          Effect.exit(
            runNativeMobileGatewaySession(proof, request.configuration, {
              detach: AbortSignal.any([signals.detach, lifetime]),
              stop: signals.stop,
            }),
          ),
        );
      },
    ),
  );
  if (Exit.isFailure(settled)) {
    const named = classifyMobileActivationCause(settled.cause);
    // A full journal of live stages is its own typed refusal with repair guidance.
    return failed(
      settled.cause,
      selected,
      selected || named === "stage-budget-exhausted" ? named : step,
    );
  }
  const session = settled.value;
  if (Exit.isFailure(session)) {
    const error = Cause.findErrorOption(session.cause);
    // Defects/interrupts after Start are never exit evidence: preserve for repair.
    return failed(
      session.cause,
      error._tag === "Some" ? error.value.repairRequired : true,
      error._tag === "Some" && error.value.reason
        ? error.value.reason
        : classifyMobileActivationCause(session.cause),
    );
  }
  const result = session.value;
  return (
    result.kind === "unavailable" ? { kind: "unavailable" } : { kind: result.disposition }
  ) as NativeMobileActivationOutcome;
});

type SelectionServices = Effect.Services<ReturnType<typeof commitMobileGatewayDesiredSelection>>;
export type NativeMobileActivationServices = Effect.Services<
  ReturnType<typeof runNativeMobileActivation>
>;
