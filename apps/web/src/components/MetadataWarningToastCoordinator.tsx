import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";

import { randomUUID } from "../lib/utils";
import { readNativeApi } from "../rpc/nativeApi";
import { useWsConnectionStatus } from "../rpc/wsConnectionState";
import { toastManager } from "./ui/toast";
import { useThreadRenameRequest } from "./sidebar/Sidebar.threadRenameRequest";
import {
  createMetadataWarningDelivery,
  metadataWarningToast,
} from "./MetadataWarningToastCoordinator.logic";

/** Global, not tied to the selected thread. Other windows can take over expired delivery claims. */
export function MetadataWarningToastCoordinator() {
  const connection = useWsConnectionStatus();
  const navigate = useNavigate();
  const delivery = useRef<ReturnType<typeof createMetadataWarningDelivery> | null>(null);

  useEffect(() => {
    const api = readNativeApi();
    if (connection.phase !== "connected" || !api) return;
    delivery.current ??= createMetadataWarningDelivery(randomUUID());
    const consumer = delivery.current;
    let active = true;
    const poll = () => {
      void consumer
        .poll(
          api.server,
          (warning) =>
            toastManager.add(
              metadataWarningToast(
                warning,
                () => void navigate({ to: "/settings/ai", hash: "text-generation-model" }),
                () => useThreadRenameRequest.getState().request(warning.threadId),
              ),
            ),
          () => active,
        )
        // No raw provider or transport errors in toasts. Pending rows survive this failure.
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [connection.phase, connection.connectedAt, navigate]);

  return null;
}
