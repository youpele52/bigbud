import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";

/** Only reserved(0) -> terminal/interrupted(1) can produce this persisted no-dispatch proof. */
export function isV2CancelledReservation(row: ProviderTurnAdmission): boolean {
  return (
    row.namespace === "foreground" &&
    row.state === "terminal" &&
    row.revision === 1 &&
    row.terminalOutcome === "interrupted" &&
    row.finalText === null
  );
}
