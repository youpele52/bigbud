import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useMobileOrchestrationSync } from "../hooks/useMobileOrchestrationSync";
import { MobileRpcClient } from "../lib/mobileRpc";
import { resolveMobileWebsocketUrl } from "../lib/mobileSession";
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
  const queryClient = useQueryClient();
  const wsUrl = useMemo(() => (session ? resolveMobileWebsocketUrl(session) : null), [session]);
  const client = useMemo(
    () =>
      wsUrl
        ? new MobileRpcClient(wsUrl, {
            onOpen: () => {
              void queryClient.invalidateQueries({ queryKey: ["mobile-snapshot"] });
              void queryClient.invalidateQueries({ queryKey: ["mobile-thread"] });
            },
          })
        : null,
    [queryClient, wsUrl],
  );
  useMobileOrchestrationSync(session, client);

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
