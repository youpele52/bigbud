import { useEffect } from "react";

import { readNativeApi } from "~/rpc/nativeApi";
import { useStore } from "~/stores/main";

import { startMascotOrchestrationSync } from "./MascotStateCoordinator.logic";

/** Keeps the lightweight mascot window synchronized without mounting the full app shell. */
export function MascotStateCoordinator() {
  const applyOrchestrationEvents = useStore((state) => state.applyOrchestrationEvents);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    return startMascotOrchestrationSync({
      api,
      applyOrchestrationEvents,
    });
  }, [applyOrchestrationEvents]);

  return null;
}
