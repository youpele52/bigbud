import { type ThreadId } from "@bigbud/contracts";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { readNativeApi } from "~/rpc/nativeApi";
import { useStore } from "~/stores/main";
import { useWsConnectionStatus } from "~/rpc/wsConnectionState";

import { listAutomationThreadIds } from "./automationDirectory";
import { useAutomationThreadIdsStore } from "./automationThreadIds.store";

export function useAutomationThreadIds() {
  const api = readNativeApi();
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const wsPhase = useWsConnectionStatus().phase;
  const revision = useAutomationThreadIdsStore((store) => store.revision);
  const pathname = useLocation({ select: (location) => location.pathname });
  const readyToLoad = Boolean(api) && bootstrapComplete && wsPhase === "connected";
  const [automationThreadIds, setAutomationThreadIds] = useState<ReadonlySet<ThreadId>>(new Set());

  useEffect(() => {
    let cancelled = false;

    if (!readyToLoad || !api) {
      return;
    }

    void (async () => {
      try {
        const nextThreadIds = await listAutomationThreadIds(api.server);
        if (!cancelled) {
          setAutomationThreadIds(nextThreadIds);
        }
      } catch {
        if (!cancelled) {
          setAutomationThreadIds(new Set());
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, pathname, readyToLoad, revision]);

  return automationThreadIds;
}
