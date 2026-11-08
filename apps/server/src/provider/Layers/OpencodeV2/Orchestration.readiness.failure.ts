import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";
import { V2BootstrapContractError } from "./Orchestration.readiness.contract.ts";

export type V2ReadinessOperation =
  | "implementation"
  | "artifact"
  | "native-eligibility"
  | "native-policy"
  | "rpc-info"
  | "contract"
  | "source";
export interface V2ReadinessFailure {
  readonly operation: V2ReadinessOperation | "ready-stamp";
  readonly reason: "unconfirmed" | "bootstrap-contract-incompatible";
  readonly fields?: readonly string[];
}

/** Retain the verification stage, never the SDK cause containing request bodies or credentials. */
export class V2ReadinessError extends Error {
  constructor(readonly operation: V2ReadinessOperation) {
    super(
      `V2 required bigbud thread-tools setup is incomplete [operation=${operation}]; existing history retained.`,
    );
  }
}

export function v2ReadinessFailure(error: unknown): V2ReadinessFailure {
  return {
    ...(error instanceof V2BootstrapContractError ? { fields: error.fields } : {}),
    operation:
      error instanceof V2ReadinessError
        ? error.operation
        : error instanceof V2NativeCompatibilityError
          ? "contract"
          : "ready-stamp",
    reason:
      error instanceof V2NativeCompatibilityError &&
      error.reasonCode === "bootstrap-contract-incompatible"
        ? error.reasonCode
        : "unconfirmed",
  };
}

/** Prefix every job phase with the fixed-vocabulary reason that originally required setup. */
export function v2ReadinessSetupReason(failure: V2ReadinessFailure | undefined, reason?: string) {
  return failure
    ? `Unchanged readiness verification failed [operation=${failure.operation}; reason=${failure.reason}${failure.fields?.length ? `; fields=${failure.fields.join(",")}` : ""}].${reason ? ` ${reason}` : ""}`
    : reason;
}
