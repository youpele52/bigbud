import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";

import { useMobileOrchestrationSync } from "../hooks/useMobileOrchestrationSync";
import { useMobileConnection } from "../lib/mobileConnection";
import { resolveMobileWebsocketUrl } from "../lib/mobileSession";
import {
  initialMobileConnectionState,
  type MobileConnectionState,
} from "../logic/mobileConnection.logic";
import { initialMobileRecoveryState } from "../logic/mobileRecovery.types";
import { useMobileSessionState } from "./MobileSessionContext";

interface MobileRpcState {
  readonly client: ReturnType<typeof useMobileConnection>["client"];
  readonly wsUrl: string | null;
  readonly connection: MobileConnectionState;
  readonly restart: () => void;
  readonly recovery: ReturnType<typeof useMobileOrchestrationSync>["controller"];
  readonly recoveryState: ReturnType<typeof useMobileOrchestrationSync>["recoveryState"];
}

const MobileRpcContext = createContext<MobileRpcState>({
  client: null,
  wsUrl: null,
  connection: initialMobileConnectionState(),
  restart: () => undefined,
  recovery: null,
  recoveryState: initialMobileRecoveryState(),
});

export function MobileRpcProvider({ children }: { children: ReactNode }) {
  const { session } = useMobileSessionState();
  const recoveryRef = useRef<ReturnType<typeof useMobileOrchestrationSync>["controller"]>(null);
  const wsUrl = useMemo(() => (session ? resolveMobileWebsocketUrl(session) : null), [session]);
  const { client, connection, restart } = useMobileConnection(session, wsUrl, {
    onClose: () => recoveryRef.current?.transportClosed(),
    onOpen: () => recoveryRef.current?.transportOpened(),
  });
  const { controller: recovery, recoveryState } = useMobileOrchestrationSync(session, client);
  recoveryRef.current = recovery;

  const value = useMemo<MobileRpcState>(
    () => ({
      client,
      wsUrl,
      connection,
      restart,
      recovery,
      recoveryState,
    }),
    [client, connection, recovery, recoveryState, restart, wsUrl],
  );

  return <MobileRpcContext.Provider value={value}>{children}</MobileRpcContext.Provider>;
}

export function useMobileRpcClient() {
  return useContext(MobileRpcContext);
}
