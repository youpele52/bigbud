import type { OrganizationAutomationStatus } from "@bigbud/contracts/server/organizationAutomation.ts";
import { useEffect, useSyncExternalStore } from "react";
import { getWsRpcClient } from "../rpc/wsRpcClient";
import { useWsConnectionStatus } from "../rpc/wsConnectionState";

const POLL_MS = 5000;

/** One shared poll per connection, however many components show the status. */
function createOrganizationStatusStore(
  read: () => Promise<OrganizationAutomationStatus> = () => getWsRpcClient().organization.status(),
) {
  let status: OrganizationAutomationStatus | undefined;
  let connection: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending = false;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const refresh = async () => {
    if (pending || listeners.size === 0) return;
    pending = true;
    const requested = connection;
    try {
      const next = await read();
      if (requested === connection) status = next;
    } catch {
      if (requested === connection) status = undefined;
    } finally {
      pending = false;
      emit();
    }
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        timer = setInterval(() => void refresh(), POLL_MS);
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    snapshot: () => status,
    /** A new socket/connection discards the previous server's status immediately. */
    connect(next: string) {
      if (next === connection) return;
      connection = next;
      status = undefined;
      emit();
      void refresh();
    },
  };
}

export const organizationStatusStore = createOrganizationStatusStore();
export { createOrganizationStatusStore };

export function useOrganizationStatus() {
  const connection = useWsConnectionStatus();
  useEffect(() => {
    organizationStatusStore.connect(
      `${connection.socketUrl ?? ""}|${connection.connectedAt ?? ""}`,
    );
  }, [connection.socketUrl, connection.connectedAt]);
  return useSyncExternalStore(organizationStatusStore.subscribe, organizationStatusStore.snapshot);
}
