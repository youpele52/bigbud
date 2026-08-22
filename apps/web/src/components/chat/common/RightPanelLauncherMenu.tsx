import { SidebarRight01Icon, SidebarRightIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

interface RightPanelToggleButtonProps {
  rightPanelOpen: boolean;
  rightPanelToggleShortcutLabel: string | null;
  onToggle: () => void;
}

export function RightPanelToggleButton({
  rightPanelOpen,
  rightPanelToggleShortcutLabel,
  onToggle,
}: RightPanelToggleButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={rightPanelOpen ? "Close right panel" : "Open right panel"}
            aria-pressed={rightPanelOpen}
            className="shrink-0"
            onClick={onToggle}
            size="icon-xs"
            variant="toolbar"
          >
            {rightPanelOpen ? (
              <HugeiconsIcon
                aria-hidden="true"
                className="size-3.5"
                icon={SidebarRight01Icon}
                size={14}
                strokeWidth={1.5}
              />
            ) : (
              <HugeiconsIcon
                aria-hidden="true"
                className="size-3.5"
                icon={SidebarRightIcon}
                size={14}
                strokeWidth={1.5}
              />
            )}
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {rightPanelOpen ? "Close right panel" : "Open right panel"}
        {rightPanelToggleShortcutLabel && <> ({rightPanelToggleShortcutLabel})</>}
      </TooltipPopup>
    </Tooltip>
  );
}
