import type {
  RemoteRuntimeUpdateOperation,
  RemoteRuntimeUpdateStatus,
} from "@bigbud/contracts/server/remoteBackendUpdate.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import type { RemoteRuntimeUpdateRpcMethods } from "../../rpc/wsRpcClient.remoteBackendUpdate";
import { toastManager } from "../ui/toast";
import {
  describeActionError,
  liveOperation,
  readRemoteRuntimeUpdateFailure,
} from "./RemoteBackendUpdate.logic";
import { updateTransitionToast, type UpdateToast } from "./RemoteBackendUpdate.toast";

export const UPDATE_LIVE_POLL_MS = 2_000;
export const UPDATE_IDLE_POLL_MS = 30_000;

export function showUpdateToast(toast: UpdateToast): void {
  toastManager.add({ type: toast.type, title: toast.title, description: toast.description });
}

export interface RemoteBackendUpdateModel {
  readonly status: RemoteRuntimeUpdateStatus | null;
  /** The backend answered `unavailable`/`unauthorized`: updates cannot run here. */
  readonly refused: string | null;
  /** Last status read failed (for example while the backend restarts); polling continues. */
  readonly statusError: string | null;
  readonly busy: boolean;
  readonly refresh: () => Promise<RemoteRuntimeUpdateStatus | null>;
  readonly requestUpdate: (version: string) => Promise<void>;
  readonly cancel: (operation: RemoteRuntimeUpdateOperation) => Promise<void>;
}

/** Status, polling, request and cancel for this window's backend. Consent lives in the
 * interrupt hook so that nothing here can ever send it. */
export function useRemoteBackendUpdate(
  client: RemoteRuntimeUpdateRpcMethods | null,
  pollMs: { readonly live: number; readonly idle: number } = {
    live: UPDATE_LIVE_POLL_MS,
    idle: UPDATE_IDLE_POLL_MS,
  },
): RemoteBackendUpdateModel {
  const [status, setStatus] = useState<RemoteRuntimeUpdateStatus | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // undefined until the first read, so pre-existing history never toasts.
  const previous = useRef<RemoteRuntimeUpdateOperation | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!client) return null;
    try {
      const next = await client.getRemoteRuntimeUpdateStatus({});
      const toast = updateTransitionToast(previous.current, next.operation);
      if (toast) showUpdateToast(toast);
      previous.current = next.operation;
      setStatus(next);
      setStatusError(null);
      setRefused(null);
      return next;
    } catch (error) {
      const typed = readRemoteRuntimeUpdateFailure(error);
      if (typed?.code === "unavailable" || typed?.code === "unauthorized")
        setRefused(typed.message || "Runtime updates are not available on this backend.");
      else setStatusError(describeActionError(error));
      return null;
    }
  }, [client]);

  const live = liveOperation(status) !== null;
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(tick, live ? pollMs.live : pollMs.idle);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, live, pollMs.idle, pollMs.live, refresh]);

  const requestUpdate = useCallback(
    async (version: string) => {
      if (!client) return;
      setBusy(true);
      try {
        const result = await client.requestRemoteRuntimeUpdate({
          requestId: randomUUID(),
          version,
          source: "release",
          interrupt: false,
        });
        if (result.disposition === "conflict")
          showUpdateToast({
            type: "warning",
            title: "Another update is running",
            description: `This backend is already updating to bigbud ${result.operation.version}.`,
          });
        else
          showUpdateToast({
            type: "info",
            title: "Remote update started",
            description: `Preparing bigbud ${result.operation.version} on this backend.`,
          });
      } catch (error) {
        showUpdateToast({
          type: "error",
          title: "Could not start the update",
          description: describeActionError(error),
        });
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [client, refresh],
  );

  const cancel = useCallback(
    async (operation: RemoteRuntimeUpdateOperation) => {
      if (!client) return;
      setBusy(true);
      try {
        await client.cancelRemoteRuntimeUpdate({ operationId: operation.operationId });
      } catch (error) {
        showUpdateToast({
          type: "error",
          title: "Could not cancel the update",
          description: describeActionError(error),
        });
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [client, refresh],
  );

  return { status, refused, statusError, busy, refresh, requestUpdate, cancel };
}
