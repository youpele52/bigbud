import { useEffect, useRef } from "react";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { toastManager } from "./ui/toast";
import { getModelDiscoveryToast } from "./ModelDiscoveryToast.logic";

/** Updates one toast per provider and ignores repeated catalog snapshots. */
export function useModelDiscoveryToasts(providers: ReadonlyArray<ServerProvider>) {
  const states = useRef(
    new Map<
      string,
      { key: string; operationId: string; id: ReturnType<typeof toastManager.add> }
    >(),
  );
  useEffect(() => {
    for (const provider of providers) {
      const decision = getModelDiscoveryToast(provider);
      const previous = states.current.get(provider.provider);
      if (!decision) {
        if (previous) {
          toastManager.close(previous.id);
          states.current.delete(provider.provider);
        }
        continue;
      }
      const { key, operationId, ...toast } = decision;
      if (previous?.key === key) continue;
      const options = { ...toast, data: { hideCopyButton: true } };
      const sameOperation = previous?.operationId === operationId;
      if (previous && !sameOperation) toastManager.close(previous.id);
      const id = previous && sameOperation ? previous.id : toastManager.add(options);
      if (sameOperation) toastManager.update(id, options);
      states.current.set(provider.provider, { key, operationId, id });
    }
  }, [providers]);
}
