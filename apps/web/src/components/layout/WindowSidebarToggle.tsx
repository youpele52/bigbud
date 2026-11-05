import { SidebarLeft01Icon, SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { cn } from "~/lib/utils";
import { shortcutLabelForCommand } from "../../models/keybindings";
import { useServerKeybindings } from "../../rpc/serverState";
import { useSidebar } from "../ui/sidebar";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WINDOW_SIDEBAR_TOGGLE_POSITION_CLASS } from "./windowChrome";

/**
 * The desktop sidebar toggle, fixed beside the traffic lights like other desktop chat apps. It is
 * rendered once for the whole window, so every page has it whether the sidebar is open or closed.
 */
export function WindowSidebarToggle() {
  const { open, toggleSidebar } = useSidebar();
  const keybindings = useServerKeybindings();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className={cn(
              WINDOW_SIDEBAR_TOGGLE_POSITION_CLASS,
              // A plain icon like other desktop apps: hover highlights it, open/closed does not.
              "data-pressed:bg-transparent dark:data-pressed:bg-transparent [-webkit-app-region:no-drag]",
            )}
            pressed={open}
            onPressedChange={toggleSidebar}
            aria-label="Toggle sidebar"
            variant="toolbar"
            size="xs"
          >
            <HugeiconsIcon
              aria-hidden="true"
              className="size-4"
              icon={open ? SidebarLeft01Icon : SidebarLeftIcon}
              size={16}
              strokeWidth={1.5}
            />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {open ? "Hide sidebar" : "Show sidebar"}
        {shortcutLabel && <> ({shortcutLabel})</>}
      </TooltipPopup>
    </Tooltip>
  );
}
