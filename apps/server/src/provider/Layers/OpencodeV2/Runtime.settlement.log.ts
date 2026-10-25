import { Effect, ServiceMap } from "effect";

/** Services (logger, minimum log level, annotations) of the server layer that built the adapter.
 * Diagnostics are emitted from plain promise code (request guards, settlement), so the adapter
 * factory binds its own services once; until then the default runtime is used. */
let services: ServiceMap.ServiceMap<never> = ServiceMap.empty();

export function bindV2SettlementLogServices(bound: ServiceMap.ServiceMap<never>) {
  services = bound;
}

/** Redacted structured diagnostics. Callers pass identifiers, reasons and counts only: never
 * prompts, message bodies, request bodies, tokens, credentials or native error text. */
export function logV2SettlementDiagnostic(
  message: string,
  details: Readonly<Record<string, string | number | boolean | ReadonlyArray<unknown>>>,
) {
  Effect.runForkWith(services)(Effect.logWarning(message, details));
}
