import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import type { ServerUsageSummaryResult } from "@bigbud/contracts/server/usage.ts";

type UsagePanelServer = Pick<NativeApi["server"], "getUsageSummary">;
const pendingRequests = new WeakMap<UsagePanelServer, Promise<ServerUsageSummaryResult>>();

/** Serialize panel RPCs across unmount/reopen; closed queued requests never execute. */
export async function requestUsagePanelSummary(
  server: UsagePanelServer,
  isCurrent: () => boolean,
): Promise<ServerUsageSummaryResult> {
  let previous = pendingRequests.get(server);
  while (previous) {
    try {
      await previous;
    } catch {
      /* The active panel owns error presentation. */
    }
    previous = pendingRequests.get(server);
  }
  if (!isCurrent()) throw new Error("Usage request is no longer active");
  const request = server.getUsageSummary({ range: "24h" });
  pendingRequests.set(server, request);
  try {
    return await request;
  } finally {
    if (pendingRequests.get(server) === request) pendingRequests.delete(server);
  }
}
