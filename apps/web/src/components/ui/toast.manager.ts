import { Toast } from "@base-ui/react/toast";
import type { ThreadId } from "@bigbud/contracts";
import { announceMascotAttention } from "../floating-assistant/mascotAttention.logic";
import { withToastPolicy } from "./toast.policyManager";

export type ThreadToastData = {
  threadId?: ThreadId | null;
  tooltipStyle?: boolean;
  dismissAfterVisibleMs?: number;
  hideOnActiveThread?: boolean;
  hideCopyButton?: boolean;
  icon?: "wifi";
  /** Marks an ongoing condition so a dismissed notice is not immediately re-shown. */
  conditionKey?: string;
};

const toastPolicy = withToastPolicy(Toast.createToastManager<ThreadToastData>(), {
  // Promise toasts never announced attention; suppressed condition re-shows do not show at all.
  onShow: (reason) => {
    if (reason !== "promise") announceMascotAttention();
  },
});

export const toastManager = toastPolicy.manager;
// Legacy callers keep the same API, but all app notifications share one stack.
export const anchoredToastManager = toastManager;
/** Close as a user/auto dismissal (unlike `toastManager.close`, the owner's own close). */
export const dismissToast = toastPolicy.dismiss;
