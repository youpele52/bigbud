import * as fs from "node:fs/promises";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  withMobileOptionalPublisher,
  type MobileOptionalPublisher,
} from "../remote-agent/mobileOptionalPublication.ts";
import type { MobileGatewayConfiguration } from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { acquireMobileGatewayActivationAuthority } from "./mobileGatewayActivation.authority.ts";
import type { RemoteMobileNativeInputsValue } from "./mobileGatewayActivation.inputs.ts";
import { commitMobileGatewayDesiredSelection } from "./mobileGatewayActivation.selection.ts";
import {
  runNativeMobileGatewaySession,
  type NativeMobileGatewaySessionSignals,
} from "./mobileGatewayNative.session.ts";

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
  | { readonly kind: "failed"; readonly repairRequired: boolean; readonly cause: unknown };

const failed = (cause: unknown, repairRequired = false): NativeMobileActivationOutcome => ({
  kind: "failed",
  repairRequired,
  cause,
});

/** Publish once, or remint the already-published stage of the current durable consent. */
async function verifiedPublication(
  publisher: MobileOptionalPublisher,
  inputs: RemoteMobileNativeInputsValue,
  consentRevision: number,
  published: boolean,
  signal: AbortSignal,
) {
  const { artifacts } = inputs;
  if (published) return publisher.remint(artifacts.stageId, consentRevision);
  const [gatewayBytes, assetsBytes] = await Promise.all([
    fs.readFile(artifacts.gatewayPath, { signal }),
    fs.readFile(artifacts.assetsPath, { signal }),
  ]);
  signal.throwIfAborted();
  return publisher.publish({
    stageId: artifacts.stageId,
    consentRevision,
    gateway: artifacts.gateway,
    assets: artifacts.assets,
    gatewayBytes,
    assetsBytes,
  });
}

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
  if (Exit.isFailure(journal)) return failed(journal.cause);
  const state = journal.value;
  if (state.schemaVersion !== 3 || !state.mobile.consent.enabled)
    return { kind: "disabled" } as NativeMobileActivationOutcome;
  const consentRevision = state.mobile.consent.revision;
  const published = state.mobile.stages.some(
    (stage) =>
      stage.id === inputs.artifacts.stageId &&
      stage.consentRevision === consentRevision &&
      stage.phase === "files-published",
  );
  const run = Effect.runPromiseWith(
    yield* Effect.services<
      Effect.Services<ReturnType<typeof runNativeMobileGatewaySession>> | SelectionServices
    >(),
  );
  let selected = false;
  const settled = yield* Effect.exit(
    withMobileOptionalPublisher(inputs.trustedKeys, async (publisher, lifetime) => {
      const signal = AbortSignal.any([lifetime, retired]);
      const proof = await verifiedPublication(
        publisher,
        inputs,
        consentRevision,
        published,
        signal,
      );
      signal.throwIfAborted();
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
    }),
  );
  if (Exit.isFailure(settled)) return failed(settled.cause, selected);
  const session = settled.value;
  if (Exit.isFailure(session)) {
    const error = Cause.findErrorOption(session.cause);
    // Defects/interrupts after Start are never exit evidence: preserve for repair.
    return failed(session.cause, error._tag === "Some" ? error.value.repairRequired : true);
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
