import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { useEffect } from "react";
import { getWsRpcClient } from "../rpc/wsRpcClient.ts";

/** Only actual visible interaction refreshes a lease. Focus/timers/drafts cannot pin a tab. */
export function useOrganizationEngagement(threadId: ThreadId) {
  useEffect(() => {
    let lastSent = 0;
    const send = (engaged: boolean) => {
      void getWsRpcClient()
        .organization.engagement({ threadId, engaged })
        .catch(() => {});
    };
    const interact = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      const now = Date.now();
      if (now - lastSent < 15000) return;
      lastSent = now;
      send(true);
    };
    const hide = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) send(false);
    };
    const events = ["pointerdown", "keydown", "input", "scroll"] as const;
    for (const name of events)
      document.addEventListener(name, interact, { capture: true, passive: true });
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("blur", hide);
    // One lease on opening; visibility/focus changes alone never renew it.
    interact();
    return () => {
      for (const name of events) document.removeEventListener(name, interact, true);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("blur", hide);
      send(false);
    };
  }, [threadId]);
}
