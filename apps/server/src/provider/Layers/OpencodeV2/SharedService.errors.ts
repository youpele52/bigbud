export type V2SharedServiceStage = "registration" | "health" | "compatibility" | "generation";

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
