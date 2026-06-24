import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

import { MobileRpcClient } from "./mobileRpc";
import { resolveMobileWebsocketUrl } from "./mobileSession";
import { useMobileSessionState } from "./MobileSessionContext";

interface MobileRpcState {
  readonly client: MobileRpcClient | null;
  readonly wsUrl: string | null;
  readonly connectionError: string | null;
}

const MobileRpcContext = createContext<MobileRpcState>({
  client: null,
  wsUrl: null,
  connectionError: null,
});

export function MobileRpcProvider({ children }: { children: ReactNode }) {
  const { session } = useMobileSessionState();
  const wsUrl = useMemo(() => (session ? resolveMobileWebsocketUrl(session) : null), [session]);
  const client = useMemo(() => (wsUrl ? new MobileRpcClient(wsUrl) : null), [wsUrl]);

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
    }),
    [client, wsUrl],
  );

  return <MobileRpcContext.Provider value={value}>{children}</MobileRpcContext.Provider>;
}

export function useMobileRpcClient() {
  return useContext(MobileRpcContext);
}
