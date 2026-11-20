import type { StatusSurfaceTone } from "@bigbud/ui/statusSurface";
import type { BackendScopeState } from "../../rpc/backendScope.state";

export interface RemoteBackendWindowGuidance {
  /** Blue while working, amber for setup gaps, red for failures (UI conventions). */
  readonly tone: Extract<StatusSurfaceTone, "loading" | "warning" | "error">;
  readonly title: string;
  readonly description: string;
  /** Reloading rebinds the window: a fresh relay lease and a fresh admission check. */
  readonly retry: boolean;
}

/** Copy for a `?backend=` window that is not (or no longer) serving its backend. */
export function remoteBackendWindowGuidance(
  state: Exclude<BackendScopeState, { kind: "local" } | { kind: "bound" }>,
): RemoteBackendWindowGuidance {
  switch (state.kind) {
    case "binding":
      return {
        tone: "loading",
        title: "Connecting to remote backend",
        description: "Opening a private relay to this backend over SSH.",
        retry: false,
      };
    case "unavailable":
      return unavailableGuidance(state.reason);
    case "refused":
      if (state.refusal === "unsupported-revision")
        return {
          tone: "error",
          title: "Update required",
          description:
            "bigbud on this computer and on the remote backend use incompatible client versions. Update both to the same bigbud release, then reopen this window.",
          retry: true,
        };
      if (state.refusal === "invalid-handshake" || state.refusal === "invalid-endpoint")
        return {
          tone: "error",
          title: "Remote backend refused",
          description:
            "The remote backend answered with an unexpected handshake. Update bigbud on the remote host, then retry.",
          retry: true,
        };
      return {
        tone: "error",
        title: "Remote backend identity changed",
        description:
          "This backend no longer matches the identity saved for it, so this window disconnected from it. Verify the host, then set the backend up again from the main window.",
        retry: false,
      };
  }
}

function unavailableGuidance(
  reason: Extract<BackendScopeState, { kind: "unavailable" }>["reason"],
): RemoteBackendWindowGuidance {
  switch (reason) {
    case "invalid-profile":
      return {
        tone: "error",
        title: "Invalid remote backend",
        description:
          "This window was opened with an invalid backend profile. Close it and open the backend again from the sidebar.",
        retry: false,
      };
    case "setup-required":
      return {
        tone: "warning",
        title: "Remote backends unavailable",
        description:
          "No installed remote backend is set up on this computer yet. Set one up from the main window, then reopen this window.",
        retry: true,
      };
    case "not-found":
      return {
        tone: "warning",
        title: "Remote backend not found",
        description:
          "This backend profile no longer exists on this computer. Close this window and choose another backend.",
        retry: false,
      };
    case "relay-failed":
      return {
        tone: "error",
        title: "Could not reach remote backend",
        description:
          "The relay to this backend could not be opened. Check that the host is reachable over SSH and that bigbud is running on this computer, then retry.",
        retry: true,
      };
  }
}
