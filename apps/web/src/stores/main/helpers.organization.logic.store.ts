import type { ThreadOrganization } from "@bigbud/contracts/orchestration/orchestration.organization.ts";

/**
 * Keeps the newer of two organizations. Revisions only grow, so a page fetched before a live
 * move cannot restore the thread's earlier state.
 */
export function newerOrganization(
  current: ThreadOrganization | undefined,
  incoming: ThreadOrganization | undefined,
): ThreadOrganization | undefined {
  if (current === undefined) return incoming;
  if (incoming === undefined) return current;
  return incoming.revision >= current.revision ? incoming : current;
}
