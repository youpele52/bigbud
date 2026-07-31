import type { ServerProviderUpdatedPayload } from "@bigbud/contracts";
import { useCallback, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { ensureNativeApi } from "../rpc/nativeApi";
import { applyProvidersUpdated } from "../rpc/serverState";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The server could not start CLIProxyAPI.";
}

export function useCliProxyActivation() {
  const [isActivating, setIsActivating] = useState(false);
  const inFlightRef = useRef<Promise<ServerProviderUpdatedPayload | null> | null>(null);

  const activate = useCallback(() => {
    const inFlight = inFlightRef.current;
    if (inFlight) return inFlight;

    setIsActivating(true);
    const operation = ensureNativeApi()
      .server.activateCliProxy()
      .then((result) => {
        applyProvidersUpdated(result);
        return result;
      })
      .catch((cause: unknown) => {
        const message = errorMessage(cause);
        toastManager.add({
          type: "error",
          title: "CLIProxyAPI could not start",
          description: `${message} Check the CLIProxyAPI config and Claude CLI path, then retry.`,
        });
        return null;
      })
      .finally(() => {
        inFlightRef.current = null;
        setIsActivating(false);
      });
    inFlightRef.current = operation;
    return operation;
  }, []);

  return { activateCliProxy: activate, isActivatingCliProxy: isActivating };
}
