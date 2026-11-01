import { useNavigate } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";

import { APP_STAGE_LABEL } from "../../config/branding";
import { isElectron } from "../../config/env";
import { SidebarFooter, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { SidebarHelpMenu } from "./SidebarHelpMenu";
import { SidebarBrandLink } from "./SidebarHeader";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

/**
 * The sidebar footer: the update notice, then Settings and Help. Desktop builds with a stage
 * (dev, nightly, beta, preview) centre the wordmark and stage badge between them, so you can tell
 * builds apart; stable releases show neither. The side columns never shrink below their content,
 * so a narrow sidebar moves the wordmark off centre rather than overlapping them.
 */
export function SidebarFooterBar() {
  const navigate = useNavigate();
  const showBrand = isElectron && Boolean(APP_STAGE_LABEL);

  return (
    <SidebarFooter className="p-2">
      <SidebarUpdatePill />
      <div
        className={
          showBrand
            ? "grid grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)] items-center gap-1"
            : "flex items-center gap-1"
        }
      >
        <SidebarMenu className="min-w-0 flex-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              onClick={() => void navigate({ to: "/settings" })}
            >
              <SettingsIcon className={SIDEBAR_COMPACT_ICON_SIZE_CLASS} />
              <span className="text-xs">Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {showBrand && <SidebarBrandLink className="px-1 py-1" logoClassName="h-3" />}
        <div className="flex justify-end">
          <SidebarHelpMenu />
        </div>
      </div>
    </SidebarFooter>
  );
}
