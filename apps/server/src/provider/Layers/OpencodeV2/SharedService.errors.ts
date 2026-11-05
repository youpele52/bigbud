import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";
import { V2DiagnosticError } from "./PluginSetup.diagnostics.ts";
export type V2SharedServiceStage =
  | "registration"
  | "health"
  | "compatibility"
  | "generation"
  | "storage";

/** Setup failures contain only authored diagnostics, never native responses or auth. */
export class V2SharedServiceError extends Error {
  constructor(
    readonly stage: V2SharedServiceStage,
    message: string,
    readonly version?: string,
  ) {
    super(message);
    this.name = "V2SharedServiceError";
  }
}

/** Erase private/auth-bearing causes before manager/adapter/trace serialization. */
export function v2AcquisitionFailure(error: unknown): V2DiagnosticError {
  if (
    (error instanceof V2DiagnosticError || error instanceof V2NativeCompatibilityError) &&
    error.diagnostic
  )
    return new V2DiagnosticError(
      error.diagnostic.stage,
      error.diagnostic.code,
      error.diagnostic.sourceIndex,
      error.diagnostic.sourceCount,
    );
  const codes = {
    registration: "registration-unverified",
    health: "health-unverified",
    compatibility: "contract-unverified",
    generation: "generation-mismatch",
    storage: "storage-namespace-mismatch",
  } as const;
  return new V2DiagnosticError(
    "acquisition",
    error instanceof V2SharedServiceError ? codes[error.stage] : "acquisition-unverified",
  );
}
