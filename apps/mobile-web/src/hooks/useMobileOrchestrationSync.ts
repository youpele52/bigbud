import { type OrchestrationEvent } from "@bigbud/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { createMobileOrchestrationSyncController } from "../logic/mobileOrchestrationSync.logic";
import type { StoredMobileSession } from "../lib/mobileSession";
import type { MobileRpcClient } from "../lib/mobileRpc";

export function useMobileOrchestrationSync(
  session: StoredMobileSession | null,
  client: MobileRpcClient | null,
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!client || !session) {
      return;
    }

    const controller = createMobileOrchestrationSyncController({
      queryClient,
      sessionId: session.sessionId,
    });

    const unsubscribe = client.onDomainEvent((event) => {
      controller.queueEvent(event as OrchestrationEvent);
    });

    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [client, queryClient, session]);
}
