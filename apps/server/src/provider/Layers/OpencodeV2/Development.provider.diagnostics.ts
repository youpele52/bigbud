import { V2HttpStatusError } from "./Client.errors.ts";
import { V2ResponseSizeError } from "./Client.response.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";

export type V2DiscoveryPhase =
  | "connection"
  | "server.info"
  | "model.list"
  | "provider.list"
  | "catalog normalization"
  | "integration.list"
  | "agent.list"
  | "skill.list"
  | "inventory bounds"
  | "public catalog";

/** Report only authored phase/location and local classifications, never a native exception/body. */
export function v2SharedDiscoveryFailure(
  phase: V2DiscoveryPhase,
  directory: string,
  error: unknown,
): string {
  const reason =
    error instanceof V2HttpStatusError
      ? ` (HTTP ${error.status})`
      : error instanceof V2ResponseSizeError
        ? " (response safety bound exceeded)"
        : error instanceof V2SharedServiceError
          ? ` (${error.stage} verification failed)`
          : "";
  const location = JSON.stringify(directory.slice(0, 256) + (directory.length > 256 ? "…" : ""));
  return `Shared OpenCode v2 discovery failed during ${phase}${reason} for Location ${location}. Native model availability is unverified; cached models are setup-only, not proof of a disconnected account. Check the native TUI service and this Location, then refresh. No history was rebound or resent.`;
}
