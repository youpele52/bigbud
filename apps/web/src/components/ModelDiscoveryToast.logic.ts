import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";

/** Maps replayable server recovery state to one stable, severity-bearing toast. */
export function getModelDiscoveryToast(provider: ServerProvider) {
  const recovery = provider.modelRecovery;
  if (!provider.enabled || !recovery) return undefined;
  const name = provider.provider;
  const working = recovery.status === "retrying";
  const recovered = recovery.status === "recovered";
  return {
    operationId: recovery.operationId,
    key: `${recovery.operationId}:${recovery.attempt}:${recovery.status}`,
    type: working ? ("info" as const) : recovered ? ("success" as const) : ("warning" as const),
    title: working
      ? `Refreshing ${name} models`
      : recovered
        ? `${name} models updated`
        : `${name} model discovery unavailable`,
    description: working
      ? `Using a fallback catalog. Background retry ${Math.max(1, recovery.attempt)} of ${recovery.maxAttempts}${recovery.attempt === 0 ? " scheduled" : " in progress"}.`
      : recovered
        ? "The live model catalog has replaced the fallback."
        : "Keeping the fallback catalog. Refresh the provider to try again.",
    timeout: working ? 0 : 8_000,
  };
}
