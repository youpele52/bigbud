import type { ServerProvider } from "@bigbud/contracts";

export function preserveEnrichedProviderSnapshot(
  probed: ServerProvider,
  current: ServerProvider,
  preserve: boolean,
): ServerProvider {
  if (!preserve || probed.status !== "ready" || current.status !== "ready") return probed;
  return {
    ...probed,
    auth: current.auth.status === "unknown" ? probed.auth : current.auth,
    models: current.models,
    ...(current.modelDiscovery ? { modelDiscovery: current.modelDiscovery } : {}),
  };
}
