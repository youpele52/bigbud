import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

import { useMobileOrchestrationSync } from "../hooks/useMobileOrchestrationSync";
import { MobileRpcClient } from "../lib/mobileRpc";
import { resolveMobileWebsocketUrl } from "../lib/mobileSession";
import { initialMobileRecoveryState } from "../logic/mobileRecovery.types";
import { useMobileSessionState } from "./MobileSessionContext";

interface MobileRpcState {
  readonly client: MobileRpcClient | null;
  readonly wsUrl: string | null;
  readonly connectionError: string | null;
  readonly recovery: ReturnType<typeof useMobileOrchestrationSync>["controller"];
  readonly recoveryState: ReturnType<typeof useMobileOrchestrationSync>["recoveryState"];
}

const MobileRpcContext = createContext<MobileRpcState>({
  client: null,
  wsUrl: null,
  connectionError: null,
  recovery: null,
  recoveryState: initialMobileRecoveryState(),
});

export function MobileRpcProvider({ children }: { children: ReactNode }) {
  const { session } = useMobileSessionState();
  const recoveryRef = useRef<ReturnType<typeof useMobileOrchestrationSync>["controller"]>(null);
  const wsUrl = useMemo(() => (session ? resolveMobileWebsocketUrl(session) : null), [session]);
  const client = useMemo(
    () =>
      wsUrl
        ? new MobileRpcClient(wsUrl, {
            onClose: () => recoveryRef.current?.transportClosed(),
            onOpen: () => {
              recoveryRef.current?.transportOpened();
            },
          })
        : null,
    [wsUrl],
  );
  const { controller: recovery, recoveryState } = useMobileOrchestrationSync(session, client);
  recoveryRef.current = recovery;

  useEffect(() => {
    return () => {
      void client?.dispose();
    };
  }, [client]);

  const value = useMemo<MobileRpcState>(
    () => ({
      client,
      wsUrl,
      connectionError: null,
      recovery,
      recoveryState,
    }),
    [client, recovery, recoveryState, wsUrl],
  );

  return <MobileRpcContext.Provider value={value}>{children}</MobileRpcContext.Provider>;
}

export function useMobileRpcClient() {
  return useContext(MobileRpcContext);
}
