import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";

export type MobileConnectionNoticeModel = {
  readonly tone: "info" | "warning" | "destructive";
  readonly title: string;
  readonly description: string;
} | null;

export function resolveMobileConnectionNotice(
  state: MobileRecoveryState,
): MobileConnectionNoticeModel {
  switch (state.freshness) {
    case "refreshing":
      return {
        tone: "info",
        title: "Refreshing chats",
        description: "New activity will appear when the desktop server responds.",
      };
    case "stale":
      return {
        tone: "warning",
        title: "Showing last-known data",
        description: "The latest refresh has not completed. You can keep reading or retry.",
      };
    case "legacy":
      return {
        tone: "warning",
        title: "Live recovery markers unavailable",
        description: "This server may be behind until the next successful refresh.",
      };
    case "unavailable":
      return state.reason === null
        ? null
        : {
            tone: "destructive",
            title: "Unable to connect",
            description:
              "Your draft is kept in this tab. Retry when the desktop server is available.",
          };
    case "current":
      return null;
  }
}
