import { getMobileSessionAuthority, mobileSessionStateScope } from "../lib/mobileSessionAuthority";
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
import { createMobileRecoveryRejection } from "../logic/mobileRecovery.rejection";
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
  const stateScope = session ? mobileSessionStateScope(session, "query") : undefined;
  const cacheIdentity = useMemo(
    () =>
      session && stateScope
        ? { sessionId: session.sessionId, backendBaseUrl: session.backendBaseUrl, stateScope }
        : null,
    [session, stateScope],
  );
  const rejectionRef = useRef<{
    session: StoredMobileSession | null;
    state: ReturnType<typeof createMobileRecoveryRejection>;
  } | null>(null);
  const prior = rejectionRef.current?.session;
  if (
    !rejectionRef.current ||
    prior?.sessionId !== sessionId ||
    getMobileSessionAuthority(prior) !== getMobileSessionAuthority(session) ||
    prior?.backendBaseUrl !== session?.backendBaseUrl ||
    prior?.sessionToken !== session?.sessionToken
  ) {
    rejectionRef.current = { session, state: createMobileRecoveryRejection() };
  }
  const rejection = rejectionRef.current.state;
  const controller = useMemo(
    () =>
      client && stateScope
        ? createMobileRecoveryController({
            client,
            queryClient,
            sessionId: stateScope,
            rejection,
          })
        : null,
    [client, queryClient, stateScope, rejection],
  );

  useEffect(() => {
    clearReplacedMobileSessionCaches(queryClient, previousSession.current, cacheIdentity);
    previousSession.current = cacheIdentity;
  }, [queryClient, cacheIdentity]);

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

  return { controller, recoveryState, clearBaselineRejection: rejection.clear } as {
    readonly clearBaselineRejection: () => void;
    readonly controller: MobileRecoveryController | null;
    readonly recoveryState: MobileRecoveryState;
  };
}
