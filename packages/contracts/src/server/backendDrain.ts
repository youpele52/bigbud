import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../core/baseSchemas";

/** Additive server RPC names for the W3.2 drain consent surface. */
export const BACKEND_DRAIN_WS_METHODS = {
  get: "server.getBackendDrainConsent",
  decide: "server.decideBackendDrainConsent",
} as const;

export const BackendDrainSurface = Schema.Literals(["local", "direct-ssh", "remote-agent"]);
export type BackendDrainSurface = typeof BackendDrainSurface.Type;

export const BackendDrainPane = Schema.Struct({
  paneId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  threadId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  terminalId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  threadTitle: Schema.String.check(Schema.isMaxLength(256)),
  paneTitle: Schema.String.check(Schema.isMaxLength(256)),
  surface: BackendDrainSurface,
  keepMode: Schema.Boolean,
});
export type BackendDrainPane = typeof BackendDrainPane.Type;

export const BackendDrainConsentSnapshot = Schema.Struct({
  drainId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  panes: Schema.Array(BackendDrainPane).check(Schema.isMaxLength(64)),
  deadlineAt: Schema.Number,
});
export type BackendDrainConsentSnapshot = typeof BackendDrainConsentSnapshot.Type;

export const BackendDrainDecision = Schema.Literals(["cancel", "save-and-close", "drain-now"]);
export type BackendDrainDecision = typeof BackendDrainDecision.Type;

export const DecideBackendDrainInput = Schema.Struct({
  drainId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  decision: BackendDrainDecision,
});
export type DecideBackendDrainInput = typeof DecideBackendDrainInput.Type;

export const BackendDrainDecisionResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("accepted"), decision: BackendDrainDecision }),
  Schema.Struct({ status: Schema.Literal("already-decided") }),
  Schema.Struct({ status: Schema.Literal("unknown-drain") }),
]);
export type BackendDrainDecisionResult = typeof BackendDrainDecisionResult.Type;

export class BackendDrainConsentError extends Schema.TaggedErrorClass<BackendDrainConsentError>()(
  "BackendDrainConsentError",
  {
    code: Schema.Literals(["unavailable", "invalid"]),
    message: TrimmedNonEmptyString,
  },
) {}

export interface BackendDrainNativeApi {
  readonly getBackendDrainConsent: () => Promise<BackendDrainConsentSnapshot | null>;
  readonly decideBackendDrainConsent: (
    input: DecideBackendDrainInput,
  ) => Promise<BackendDrainDecisionResult>;
}
