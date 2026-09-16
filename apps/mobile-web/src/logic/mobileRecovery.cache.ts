import type { OrchestrationThread, ThreadId } from "@bigbud/contracts";
import {
  threadKey,
  type MobileRecoveryBaseline,
  type RecoveryQueryClient,
} from "./mobileRecovery.types";

export function installMobileSelectedThread(
  queryClient: RecoveryQueryClient,
  sessionId: string,
  selectedThreadId: ThreadId | null,
  baseline: MobileRecoveryBaseline,
) {
  if (selectedThreadId === null || baseline.selectedThread === null) return;
  const selectedThread = baseline.selectedThread;
  const key = threadKey(sessionId, selectedThreadId);
  if (selectedThread.status === "present") {
    queryClient.setQueryData<OrchestrationThread>(key, () => selectedThread.thread);
  } else {
    queryClient.removeQueries({ queryKey: key });
  }
}
