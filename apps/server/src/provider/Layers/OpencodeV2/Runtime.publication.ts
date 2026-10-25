import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { guardProviderPublication, validProviderPublication } from "../../providerPublication.ts";

/** Internal queues retain the original revision validator without changing public contracts. */
export function guardV2Publication(event: ProviderRuntimeEvent, validate?: () => void) {
  guardProviderPublication(event, validate);
}
export function validV2Publication(event: ProviderRuntimeEvent) {
  return validProviderPublication(event);
}
