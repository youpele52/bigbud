import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { getRetainedHistoryAdvisory as readRetainedHistoryAdvisory } from "@bigbud/shared/opencodeAdvisory";

/** Match only the complete authored suffix, never a substring inside a primary error. */
export function getRetainedHistoryAdvisory(status: ServerProvider | null) {
  return readRetainedHistoryAdvisory(status);
}

/** Remove only the dismissed advisory; errors and setup warnings keep their original severity. */
export function withoutDismissedRetainedHistoryAdvisory(
  status: ServerProvider | null,
  dismissed: boolean,
): ServerProvider | null {
  const advisory = getRetainedHistoryAdvisory(status);
  if (!dismissed || !advisory || !status) return status;
  if (advisory.advisoryOnly) return null;
  return { ...status, message: advisory.primaryMessage || undefined };
}
