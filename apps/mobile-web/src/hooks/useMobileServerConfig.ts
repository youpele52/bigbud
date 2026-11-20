import { mobileSessionStateScope } from "../lib/mobileSessionAuthority";
import { useEffect, useState } from "react";

import { useMobileRpcClient } from "../context/MobileRpcContext";
import {
  subscribeMobileServerConfig,
  currentMobileServerConfig,
  type ScopedMobileServerConfig,
} from "./useMobileServerConfig.logic";

export function useMobileServerConfig(session: { sessionId: string } | null) {
  const { client } = useMobileRpcClient();
  const [state, setState] = useState<ScopedMobileServerConfig | null>(null);
  const scope = session ? mobileSessionStateScope(session, "query") : undefined;
  const config = currentMobileServerConfig(state, client, scope);

  useEffect(() => {
    if (!client || !session) {
      setState(null);
      return;
    }
    return subscribeMobileServerConfig(client, scope!, setState);
  }, [client, session, scope]);

  return {
    serverConfig: config,
    providers: config?.providers ?? [],
    isLoading: client !== null && session !== null && config === null,
  };
}
