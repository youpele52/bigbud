import { useEffect } from "react";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { toastManager } from "./ui/toast";

let notified = false;
/** One notice for this web app lifetime; refresh/reconnect/remount never changes ready status. */
export function useOpencodeV2UpdateToast(providers: ReadonlyArray<ServerProvider>) {
  useEffect(() => {
    const provider = providers.find(
      (value) =>
        value.provider === "opencodeV2" &&
        value.enabled &&
        value.status === "ready" &&
        value.runtimeUpdateRecommended,
    );
    if (!provider || notified) return;
    notified = true;
    toastManager.add({
      type: "warning",
      title: "OpenCode update recommended",
      description: `OpenCode ${provider.version} is compatible. Update to ${provider.runtimeUpdateRecommended}+ when convenient; your current service remains usable.`,
      data: { hideCopyButton: true },
    });
  }, [providers]);
}
