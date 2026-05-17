import { useEffect } from "react";
import { startServerStateSync } from "../rpc/serverState";
import { getWsRpcClient } from "../rpc/wsRpcClient";

/** Mounts server state sync on startup. Renders nothing. */
export function ServerStateBootstrap() {
  useEffect(() => startServerStateSync(getWsRpcClient().server), []);

  return null;
}
