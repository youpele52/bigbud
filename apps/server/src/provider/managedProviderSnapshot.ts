import type { ServerProvider } from "@bigbud/contracts";

export function preserveEnrichedProviderSnapshot(
  probed: ServerProvider,
  current: ServerProvider,
  preserve: boolean,
): ServerProvider {
  const usageLimits = preserveLastGoodUsageLimits(probed, current);
  const withUsageLimits = usageLimits ? { ...probed, usageLimits } : probed;
  if (!preserve || probed.status !== "ready" || current.status !== "ready") {
    return withUsageLimits;
  }
  return {
    ...withUsageLimits,
    auth: current.auth.status === "unknown" ? probed.auth : current.auth,
    models: current.models,
    ...(current.modelDiscovery ? { modelDiscovery: current.modelDiscovery } : {}),
  };
}

function preserveLastGoodUsageLimits(
  probed: ServerProvider,
  current: ServerProvider,
): ServerProvider["usageLimits"] {
  const next = probed.usageLimits;
  const previous = current.usageLimits;
  if (
    !probed.enabled ||
    next?.status !== "error" ||
    (previous?.status !== "available" && previous?.status !== "stale")
  ) {
    return next;
  }
  return {
    ...previous,
    status: "stale",
    checkedAt: next.checkedAt,
    lastSuccessfulAt: previous.lastSuccessfulAt ?? previous.checkedAt,
    ...(next.message ? { message: next.message } : {}),
  };
}
