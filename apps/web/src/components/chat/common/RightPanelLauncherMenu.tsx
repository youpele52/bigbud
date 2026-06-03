import { PanelRightCloseIcon, PanelRightIcon } from "lucide-react";

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
              <PanelRightCloseIcon className="size-3" />
            ) : (
              <PanelRightIcon className="size-3" />
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
