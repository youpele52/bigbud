import { Toast } from "@base-ui/react/toast";
import type { ThreadId } from "@bigbud/contracts";
import { announceMascotAttention } from "../floating-assistant/mascotAttention.logic";

export type ThreadToastData = {
  threadId?: ThreadId | null;
  tooltipStyle?: boolean;
  dismissAfterVisibleMs?: number;
  hideOnActiveThread?: boolean;
  hideCopyButton?: boolean;
  icon?: "wifi";
};

export const toastManager = Toast.createToastManager<ThreadToastData>();
export const anchoredToastManager = Toast.createToastManager<ThreadToastData>();

function attachMascotAttention(manager: { add: typeof toastManager.add }) {
  const add = manager.add.bind(manager);
  manager.add = ((...args: Parameters<typeof add>) => {
    announceMascotAttention();
    return add(...args);
  }) as typeof manager.add;
}

attachMascotAttention(toastManager);
attachMascotAttention(anchoredToastManager);
