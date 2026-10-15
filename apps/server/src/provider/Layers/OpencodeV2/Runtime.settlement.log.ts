import { Effect } from "effect";

/** Redacted structured diagnostics. Callers pass identifiers, reasons and counts only: never
 * prompts, message bodies, request bodies, tokens, credentials or native error text. */
export function logV2SettlementDiagnostic(
  message: string,
  details: Readonly<Record<string, string | number | boolean | ReadonlyArray<unknown>>>,
) {
  Effect.runFork(Effect.logWarning(message, details));
}
