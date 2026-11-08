import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { getWsRpcClient } from "../rpc/wsRpcClient.ts";

/** Opening is bounded engagement, never an answer to an outstanding request. */
export function acknowledgeThreadOpen(threadId: ThreadId): void {
  if (
    typeof document !== "undefined" &&
    (document.visibilityState !== "visible" || !document.hasFocus())
  )
    return;
  void getWsRpcClient()
    .organization.engagement({ threadId, engaged: true })
    .catch(() => {});
}
