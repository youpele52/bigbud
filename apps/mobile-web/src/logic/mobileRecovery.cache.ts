import type { OrchestrationThread, ThreadId } from "@bigbud/contracts";
import {
  threadKey,
  type MobileRecoveryBaseline,
  type MobileRecoveryState,
  type RecoveryQueryClient,
} from "./mobileRecovery.types";

export function selectedThreadRecoveryState(
  selectedThreadId: ThreadId | null,
  baseline: MobileRecoveryBaseline,
): Pick<MobileRecoveryState, "selectedThreadStatus" | "selectedThreadHasOlderHistory"> {
  const selectedThread = baseline.selectedThread;
  return {
    selectedThreadStatus:
      selectedThreadId === null ? "none" : (selectedThread?.status ?? "unknown"),
    selectedThreadHasOlderHistory:
      selectedThreadId !== null &&
      selectedThread?.status === "present" &&
      selectedThread.hasOlderHistory === true,
  };
}

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
