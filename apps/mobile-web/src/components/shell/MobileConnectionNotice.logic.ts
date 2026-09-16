import type { MobileConnectionState } from "../../logic/mobileConnection.logic";
import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";

export type MobileConnectionNoticeModel = {
  readonly tone: "info" | "warning" | "destructive";
  readonly title: string;
  readonly description: string;
  readonly showRetry: boolean;
  readonly actionsDisabled: boolean;
  readonly placement: "conversation" | "composer";
  readonly announcementKey: string;
} | null;

export interface MobileConnectionPresentationInput {
  readonly connection: MobileConnectionState;
  readonly recoveryState: MobileRecoveryState;
  readonly keyboardReduced?: boolean;
}

function model(
  tone: "info" | "warning" | "destructive",
  title: string,
  description: string,
  options?: Partial<
    Pick<NonNullable<MobileConnectionNoticeModel>, "showRetry" | "actionsDisabled">
  >,
): NonNullable<MobileConnectionNoticeModel> {
  return {
    tone,
    title,
    description,
    showRetry: options?.showRetry ?? false,
    actionsDisabled: options?.actionsDisabled ?? false,
    placement: "conversation",
    announcementKey: `${tone}:${title}`,
  };
}

export function resolveMobileConnectionPresentation({
  connection,
  recoveryState,
  keyboardReduced = false,
}: MobileConnectionPresentationInput): MobileConnectionNoticeModel {
  const actionsDisabled =
    connection.expired ||
    connection.authorization !== "unknown" ||
    connection.incidentLevel === "reconnecting" ||
    connection.incidentLevel === "escalated" ||
    connection.transport === "exhausted";
  let resolved: MobileConnectionNoticeModel;

  if (connection.authorization === "locally-expired") {
    resolved = model(
      "destructive",
      "Session expired",
      "Pair this phone again before sending commands.",
      { actionsDisabled: true },
    );
  } else if (connection.authorization === "explicitly-rejected") {
    resolved = model(
      "destructive",
      "Pairing required",
      "The desktop server rejected this connection. Pair this phone again before sending commands.",
      { actionsDisabled: true },
    );
  } else if (connection.transport === "exhausted" || connection.incidentLevel === "escalated") {
    resolved = model(
      "destructive",
      "Unable to connect",
      "The desktop server did not reconnect. Retry or open a new pairing link.",
      { showRetry: true, actionsDisabled: true },
    );
  } else if (connection.browserOffline && connection.transport !== "open") {
    resolved = model(
      "warning",
      "Device is offline",
      "Reconnect this device to continue updating chats. Your draft stays in this tab.",
      { actionsDisabled },
    );
  } else if (connection.incidentLevel === "reconnecting") {
    resolved = model(
      "info",
      "Reconnecting",
      "Typing is preserved while the desktop server reconnects.",
      { actionsDisabled: true },
    );
  } else if (connection.incidentLevel === "short") {
    return null;
  } else if (connection.transport === "open" && recoveryState.freshness === "refreshing") {
    resolved = model(
      "info",
      "Refreshing chats",
      "New activity will appear when the desktop server responds.",
      { actionsDisabled: true },
    );
  } else if (recoveryState.freshness === "stale") {
    resolved = model(
      "warning",
      "Showing last-known data",
      "The latest refresh has not completed. You can keep reading or retry.",
      { showRetry: true, actionsDisabled },
    );
  } else if (recoveryState.freshness === "legacy") {
    resolved = model(
      "warning",
      "Live recovery markers unavailable",
      "This server may be behind until the next successful refresh.",
      { showRetry: true, actionsDisabled },
    );
  } else if (connection.transport === "closed" || connection.transport === "unpaired") {
    resolved = model(
      "destructive",
      "Unable to connect",
      "Retry when the desktop server is available.",
      {
        showRetry: true,
        actionsDisabled: true,
      },
    );
  } else {
    return null;
  }

  return keyboardReduced && resolved.actionsDisabled
    ? { ...resolved, placement: "composer" }
    : resolved;
}

export function isMobileConnectionActionsBlocked(
  connection: MobileConnectionState,
  recoveryState: MobileRecoveryState,
): boolean {
  return (
    resolveMobileConnectionPresentation({ connection, recoveryState })?.actionsDisabled ?? false
  );
}

/** Compatibility resolver for callers that only have recovery evidence. */
export function resolveMobileConnectionNotice(
  state: MobileRecoveryState,
  connection?: MobileConnectionState,
): MobileConnectionNoticeModel {
  if (connection) return resolveMobileConnectionPresentation({ connection, recoveryState: state });
  switch (state.freshness) {
    case "refreshing":
      return model(
        "info",
        "Refreshing chats",
        "New activity will appear when the desktop server responds.",
      );
    case "stale":
      return model(
        "warning",
        "Showing last-known data",
        "The latest refresh has not completed. You can keep reading or retry.",
        { showRetry: true },
      );
    case "legacy":
      return model(
        "warning",
        "Live recovery markers unavailable",
        "This server may be behind until the next successful refresh.",
        { showRetry: true },
      );
    case "unavailable":
      return state.reason === null
        ? null
        : model(
            "destructive",
            "Unable to connect",
            "Your draft is kept in this tab. Retry when the desktop server is available.",
            { showRetry: true, actionsDisabled: true },
          );
    case "current":
      return null;
  }
}
