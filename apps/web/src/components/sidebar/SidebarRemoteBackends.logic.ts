import type { DesktopOpenRemoteBackendWindowResult } from "@bigbud/contracts/server/ipc.desktopRemoteBackend.ts";
import type {
  RemoteBackendRelayListResult,
  RemoteBackendRelayProfile,
} from "@bigbud/contracts/server/remoteBackendRelay.ts";

/** Typed state of the "Open remote backend" sidebar entry (one window per backend). */
export type RemoteBackendEntryState =
  | { readonly status: "loading" }
  | { readonly status: "hidden"; readonly reason: "not-desktop" | "bound-window" }
  | {
      readonly status: "unavailable";
      readonly reason: "setup-required" | "no-profiles" | "relay-failed";
    }
  | { readonly status: "available"; readonly profiles: readonly RemoteBackendRelayProfile[] };

export async function loadRemoteBackendEntry(input: {
  readonly isBoundWindow: boolean;
  readonly canOpenWindow: boolean;
  readonly list: (() => Promise<RemoteBackendRelayListResult>) | undefined;
}): Promise<RemoteBackendEntryState> {
  // A bound window talks to its remote backend, which has no local relay of its own.
  if (input.isBoundWindow) return { status: "hidden", reason: "bound-window" };
  if (!input.canOpenWindow || !input.list) return { status: "hidden", reason: "not-desktop" };
  let listed: RemoteBackendRelayListResult;
  try {
    listed = await input.list();
  } catch {
    return { status: "unavailable", reason: "relay-failed" };
  }
  if (listed.availability !== "available")
    return { status: "unavailable", reason: "setup-required" };
  if (listed.profiles.length === 0) return { status: "unavailable", reason: "no-profiles" };
  return { status: "available", profiles: listed.profiles };
}

export function remoteBackendUnavailableLabel(
  reason:
    | Extract<RemoteBackendEntryState, { status: "unavailable" }>["reason"]
    | Extract<DesktopOpenRemoteBackendWindowResult, { status: "unavailable" }>["reason"],
): string {
  switch (reason) {
    case "setup-required":
      return "Remote backends unavailable: setup required";
    case "no-profiles":
      return "No remote backends set up";
    case "relay-failed":
      return "Remote backends unavailable: relay failed";
    case "invalid-profile":
      return "Remote backend unavailable: invalid profile";
    case "not-supported":
      return "Remote backend windows need the desktop app";
  }
}
