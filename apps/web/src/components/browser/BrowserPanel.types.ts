import type { ThreadId } from "@bigbud/contracts";
import type { RightPanelTabId } from "~/stores/rightPanel/rightPanelTabs.store";

export interface BrowserPanelProps {
  activeThreadId?: ThreadId | null;
  tabId?: RightPanelTabId;
  visible?: boolean;
}
