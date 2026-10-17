import type { ServerProvider } from "@bigbud/contracts";

export function needsProviderRefresh(provider: ServerProvider): boolean {
  return provider.enabled && provider.failure !== undefined;
}

export function isProviderRetryable(provider: ServerProvider): boolean {
  if (provider.modelRecovery) return false;
  return provider.failure?.classification === "retryable";
}

/**
 * Packaged desktop startup can briefly report a command as missing while the
 * provider CLI is becoming discoverable. Retry that launch-only false
 * negative, but retain its user-action classification if all attempts fail.
 */
export function isProviderStartupRetryable(provider: ServerProvider): boolean {
  if (provider.modelRecovery) return false;
  return isProviderRetryable(provider) || provider.failure?.reason === "command-not-found";
}
