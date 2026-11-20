import type { ServerRemoteAgentUpdateStatus } from "@bigbud/contracts/server/server.ts";

/** Labels for the remote agent versions panel. */
export const REMOTE_AGENT_STATUS_LABELS = {
  running: "Running now",
  downloaded: "Downloaded update",
  backup: "Backup version",
  notVerified: "Not verified",
  none: "None",
} as const;

export const REMOTE_AGENT_STATUS_FOOTER =
  "Connect new session uses the newest verified agent. Running terminals stay on their version.";

/** Phases in which a downloaded build is not yet the running one. */
const DOWNLOADED_PHASES: ReadonlySet<ServerRemoteAgentUpdateStatus["phase"]> = new Set([
  "reserved",
  "installing",
  "checking-health",
  "waiting-for-capacity",
  "ready-for-next-reconnect",
]);

/** The downloaded update's version, or null once it is running or none exists. */
export function downloadedUpdateVersion(status: ServerRemoteAgentUpdateStatus): string | null {
  return DOWNLOADED_PHASES.has(status.phase) ? status.pendingVersion : null;
}

function buildType(targetTriple: string | undefined): string | null {
  if (!targetTriple) return null;
  if (targetTriple.endsWith("-musl")) return "musl";
  if (targetTriple.endsWith("-gnu")) return "gnu";
  return null;
}

/**
 * A version label. When the running and downloaded versions match they are different builds of
 * that version, so the build type and short digest are added: "0.4.0-beta.5 (musl build 3f2a9c1b7d4e)".
 */
export function describeAgentBuild(
  version: string,
  build: { readonly targetTriple?: string | undefined; readonly digestShort?: string | undefined },
  sameVersionAsOther: boolean,
): string {
  if (!sameVersionAsOther) return version;
  const type = buildType(build.targetTriple);
  const detail = [type ? `${type} build` : "build", build.digestShort].filter(Boolean).join(" ");
  return `${version} (${detail})`;
}

export function remoteAgentUpdateStatusMessage(status: ServerRemoteAgentUpdateStatus): string {
  const version = status.pendingVersion ?? "";
  switch (status.phase) {
    case "installing":
      return `Installing verified update ${version}. Existing work is unchanged.`;
    case "checking-health":
      return `Checking update ${version} before it can be selected.`;
    case "ready-for-next-reconnect":
      return `Update ${version} is downloaded and verified. It starts the next time you choose Connect new session. Open terminals keep running on the current version.`;
    case "waiting-for-capacity":
      return `Update ${version} is waiting for a safe storage slot.`;
    case "capacity-noncompliant":
      return "Update waiting: the remote installation has uncertain or excess builds.";
    case "failed-using-stable":
      return `Update unavailable; continuing with stable ${status.currentVersion ?? "fallback"}.`;
    case "verification-unavailable":
      return "Update verification is temporarily unavailable; existing work is unchanged.";
    case "connected":
      return status.reconnectOutcome === "fallback"
        ? `Connected using verified fallback ${status.currentVersion ?? ""}.`
        : "Connected to the current stable remote agent.";
    case "waiting-for-authentication":
      return "Update preparation will resume after remote authentication.";
    case "reserved":
      return "A safe storage slot is reserved for the verified update.";
    case "idle":
      return "Remote update preparation is idle.";
  }
}

/** Blue while working, green when done, amber for warnings. */
export function remoteAgentUpdateStatusTone(phase: ServerRemoteAgentUpdateStatus["phase"]): string {
  switch (phase) {
    case "failed-using-stable":
    case "verification-unavailable":
    case "waiting-for-capacity":
    case "capacity-noncompliant":
      return "text-amber-600";
    case "installing":
    case "checking-health":
    case "reserved":
      return "text-blue-600";
    default:
      return "text-emerald-600";
  }
}
