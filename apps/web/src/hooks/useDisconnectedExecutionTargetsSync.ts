import { useEffect } from "react";
import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";

import { readNativeApi } from "../rpc/nativeApi";
import { useWsConnectionStatus } from "../rpc/wsConnectionState";
import { useRemoteAccessStore } from "../stores/remoteAccess/remoteAccess.store";

type DisconnectedTargetsApi = {
  readonly server: Pick<NativeApi["server"], "listDisconnectedExecutionTargets">;
};

/**
 * Applies the server's persisted disconnect set, then re-applies only the targets the user
 * disconnected or connected locally while the request was in flight (those came from the
 * server too and are newer). Failures are logged and ignored so startup never depends on this
 * list; every settled, still-current attempt marks the list loaded so waiting paths never hang.
 */
export async function refreshDisconnectedExecutionTargets(
  api: DisconnectedTargetsApi,
  isCancelled: () => boolean = () => false,
): Promise<boolean> {
  const versionsBefore = useRemoteAccessStore.getState().disconnectedChangeVersions;
  try {
    // Partial native API implementations (tests, older hosts) simply skip the sync.
    if (typeof api.server?.listDisconnectedExecutionTargets !== "function") return false;
    const result = await api.server.listDisconnectedExecutionTargets();
    if (isCancelled()) return false;
    const current = useRemoteAccessStore.getState();
    const next = new Set(result.executionTargetIds);
    for (const [executionTargetId, version] of Object.entries(current.disconnectedChangeVersions)) {
      if (versionsBefore[executionTargetId] === version) continue;
      if (current.disconnectedExecutionTargetIds[executionTargetId]) next.add(executionTargetId);
      else next.delete(executionTargetId);
    }
    current.replaceDisconnectedExecutionTargetIds([...next]);
    return true;
  } catch (error) {
    console.warn("Failed to load disconnected remote workspaces.", error);
    return false;
  } finally {
    if (!isCancelled()) useRemoteAccessStore.getState().markDisconnectedTargetsLoaded();
  }
}

/** Reloads disconnected remote workspaces on every WebSocket connect and reconnect. */
export function useDisconnectedExecutionTargetsSync(): void {
  const connection = useWsConnectionStatus();
  const connectionKey =
    connection.phase === "connected"
      ? `${connection.socketUrl ?? ""}|${connection.connectedAt ?? ""}`
      : null;
  useEffect(() => {
    if (connectionKey === null) return;
    const api = readNativeApi();
    if (!api) return;
    let cancelled = false;
    void refreshDisconnectedExecutionTargets(api, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [connectionKey]);
}
