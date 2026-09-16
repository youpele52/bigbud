import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import {
  createMobileRecoveryController,
  type MobileRecoveryController,
  type MobileRecoveryState,
} from "../logic/mobileRecovery.controller";
import {
  clearReplacedMobileSessionCaches,
  type MobileRecoverySessionIdentity,
} from "../logic/mobileRecovery.session";
import { initialMobileRecoveryState } from "../logic/mobileRecovery.types";
import type { StoredMobileSession } from "../lib/mobileSession";
import type { MobileRpcClient } from "../lib/mobileRpc";

export function useMobileOrchestrationSync(
  session: StoredMobileSession | null,
  client: MobileRpcClient | null,
) {
  const queryClient = useQueryClient();
  const previousSession = useRef<MobileRecoverySessionIdentity | null>(null);
  const sessionId = session?.sessionId;
  const controller = useMemo(
    () =>
      client && sessionId
        ? createMobileRecoveryController({
            client,
            queryClient,
            sessionId,
          })
        : null,
    [client, queryClient, sessionId],
  );

  useEffect(() => {
    clearReplacedMobileSessionCaches(queryClient, previousSession.current, session);
    previousSession.current = session;
  }, [queryClient, session]);

  useEffect(() => {
    if (!controller) {
      return;
    }
    controller.start();
    return () => {
      controller.dispose();
    };
  }, [controller]);

  const emptyState = useMemo(() => initialMobileRecoveryState(), []);
  const recoveryState = useSyncExternalStore(
    controller?.subscribe ?? (() => () => undefined),
    controller?.getState ?? (() => emptyState),
    controller?.getState ?? (() => emptyState),
  );

  return { controller, recoveryState } as {
    readonly controller: MobileRecoveryController | null;
    readonly recoveryState: MobileRecoveryState;
  };
}
