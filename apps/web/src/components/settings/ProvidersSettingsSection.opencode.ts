import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import {
  getRetainedHistoryAdvisory,
  OPENCODE_RETAINED_HISTORY_ADVISORY,
} from "@bigbud/shared/opencodeAdvisory";

export interface OpenCodeSettingsStatus {
  readonly authenticated: boolean;
  readonly accounts: string | null;
  readonly historyAdvisory: string | null;
  readonly attention: {
    readonly label: string;
    readonly tone: "warning" | "error";
    readonly message: string;
  } | null;
}

/** Account authentication is not canonical execution readiness. Only the exact history
 * advisory can lose its attention badge; actual connection/setup failures remain visible. */
export function getOpenCodeSettingsStatus(provider: ServerProvider | undefined, enabled: boolean) {
  const advisory = getRetainedHistoryAdvisory(provider ?? null);
  const active = enabled && !!provider?.enabled && provider.status !== "disabled";
  const authenticated =
    active &&
    !!provider?.installed &&
    provider.initialProbeComplete !== false &&
    provider.auth.status === "authenticated" &&
    provider.failure?.reason !== "authentication-required";
  const retrying = provider?.recovery?.status === "retrying";
  const attention =
    active &&
    provider &&
    !advisory?.advisoryOnly &&
    (provider.status === "warning" || provider.status === "error" || provider.failure || retrying)
      ? {
          label: retrying
            ? "Reconnecting"
            : provider.status === "error" || provider.failure
              ? "Connection failed"
              : provider.runtimeUpdateRecommended
                ? "Update recommended"
                : "Setup needs attention",
          tone:
            provider.status === "error" || provider.failure
              ? ("error" as const)
              : ("warning" as const),
          message:
            (advisory ? advisory.primaryMessage : provider.message) ||
            "Check the native service connection and required setup.",
        }
      : null;
  const headline =
    !enabled || provider?.enabled === false || provider?.status === "disabled"
      ? "Disabled"
      : !provider
        ? "Checking provider status"
        : !provider.installed
          ? "Not found"
          : provider.initialProbeComplete === false
            ? "Checking authentication"
            : authenticated
              ? "Authenticated"
              : provider.auth.status === "unauthenticated" ||
                  provider.failure?.reason === "authentication-required"
                ? "Not authenticated"
                : provider.status === "error"
                  ? "Unavailable"
                  : "Authentication unverified";
  return {
    summary: { headline, detail: null },
    status: {
      authenticated,
      accounts: authenticated ? (provider.auth.label ?? provider.auth.type ?? null) : null,
      attention,
      historyAdvisory: advisory ? OPENCODE_RETAINED_HISTORY_ADVISORY : null,
    } satisfies OpenCodeSettingsStatus,
    statusKey: authenticated
      ? ("ready" as const)
      : !active
        ? ("disabled" as const)
        : provider?.status === "error"
          ? ("error" as const)
          : ("warning" as const),
  };
}
