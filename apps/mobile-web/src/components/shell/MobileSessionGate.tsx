import type { OrchestrationReadModel } from "@bigbud/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useMobileRpcClient } from "../../context/MobileRpcContext";
import { Button } from "../ui/button";
import { MobileConnectionNotice } from "./MobileConnectionNotice";
import { MobileStartupSplash } from "./MobileStartupSplash";
import { clearMobileSession } from "../../lib/mobileSession";
import { redactMobileText } from "../../lib/mobileRedaction";

export function MobileSessionGate({
  session,
  snapshotQuery,
  connectionError,
  children,
}: {
  session: { sessionId: string } | null;
  snapshotQuery: UseQueryResult<OrchestrationReadModel>;
  connectionError: string | null;
  children: (snapshot: OrchestrationReadModel) => ReactNode;
}) {
  const { connection, recoveryState, restart } = useMobileRpcClient();

  if (!session) {
    return (
      <div className="px-1 py-8 text-sm text-muted-foreground">
        Open a pairing link from the desktop app to authorize this phone.
      </div>
    );
  }

  const snapshot = snapshotQuery.data;
  const recoveryWaiting =
    recoveryState.freshness === "refreshing" ||
    (recoveryState.freshness === "unavailable" &&
      recoveryState.reason === null &&
      snapshotQuery.isPending);

  if (!snapshot && recoveryWaiting) {
    return <MobileStartupSplash className="min-h-[calc(100dvh-5rem)]" />;
  }

  if (!snapshot) {
    const needsPairing = connection.expired || connection.authorization === "explicitly-rejected";
    const pairAgain = () => {
      clearMobileSession();
      window.location.assign("/mobile");
    };
    return (
      <div className="grid gap-3 px-1 py-8">
        <p className="text-sm font-medium text-foreground">
          {needsPairing ? "Pairing required" : "Unable to connect"}
        </p>
        <p className="text-sm text-muted-foreground">
          {connectionError
            ? redactMobileText(connectionError)
            : "Retry or pair again if the session expired."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            className="min-h-11"
            size="sm"
            variant="outline"
            onClick={needsPairing ? pairAgain : restart}
          >
            {needsPairing ? "Pair again" : "Retry"}
          </Button>
          <Button className="min-h-11" size="sm" variant="secondary" onClick={pairAgain}>
            Forget connection
          </Button>
        </div>
      </div>
    );
  }

  const content = children(snapshot);
  const authorizationMessage =
    connection.authorization === "locally-expired"
      ? "This session expired. Pair again before sending commands."
      : connection.authorization === "explicitly-rejected"
        ? "The desktop server rejected this connection. Pair this phone again before sending commands."
        : null;
  if (
    authorizationMessage === null &&
    recoveryState.freshness !== "stale" &&
    recoveryState.freshness !== "legacy"
  ) {
    return content;
  }

  return (
    <div className="grid gap-2">
      {authorizationMessage ? (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-muted-foreground"
          role="status"
        >
          {authorizationMessage}
        </div>
      ) : null}
      {recoveryState.freshness === "stale" || recoveryState.freshness === "legacy" ? (
        <MobileConnectionNotice state={recoveryState} onRetry={restart} />
      ) : null}
      {content}
    </div>
  );
}
