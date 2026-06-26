import type { OrchestrationReadModel } from "@bigbud/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { MobileStartupSplash } from "./MobileStartupSplash";
import { clearMobileSession } from "../../lib/mobileSession";

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
  if (!session) {
    return (
      <div className="px-1 py-8 text-sm text-muted-foreground">
        Open a pairing link from the desktop app to authorize this phone.
      </div>
    );
  }

  if (snapshotQuery.isLoading) {
    return <MobileStartupSplash className="min-h-[calc(100dvh-5rem)]" />;
  }

  if (snapshotQuery.isError || !snapshotQuery.data) {
    return (
      <div className="grid gap-3 px-1 py-8">
        <p className="text-sm font-medium text-foreground">Unable to connect</p>
        <p className="text-sm text-muted-foreground">
          {connectionError ?? "Refresh the page or pair again if the session expired."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => snapshotQuery.refetch()}>
            Retry
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              clearMobileSession();
              window.location.reload();
            }}
          >
            Clear session
          </Button>
        </div>
      </div>
    );
  }

  return children(snapshotQuery.data);
}
