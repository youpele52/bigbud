import { initialMobileRecoveryState, type MobileRecoveryState } from "./mobileRecovery.types";
import type { ThreadId } from "@bigbud/contracts";
import type { MobileRecoveryRejectedBaselineError } from "../lib/mobileRpc.errors";

/** Session-owned state survives RPC client replacement; no global or persisted credentials. */
export function createMobileRecoveryRejection() {
  let selectedThreadId: ThreadId | null = null;
  let error: MobileRecoveryRejectedBaselineError | null = null;
  return {
    initialState(): MobileRecoveryState {
      return {
        ...initialMobileRecoveryState(error ? "unavailable" : "refreshing"),
        selectedThreadId,
        selectedThreadStatus: selectedThreadId ? "unknown" : "none",
        reason: error?.message ?? null,
      };
    },
    get selectedThreadId() {
      return selectedThreadId;
    },
    get error() {
      return error;
    },
    select(next: ThreadId | null) {
      if (next !== selectedThreadId) error = null;
      selectedThreadId = next;
    },
    reject(next: MobileRecoveryRejectedBaselineError) {
      error = next;
    },
    clear() {
      error = null;
    },
  };
}
