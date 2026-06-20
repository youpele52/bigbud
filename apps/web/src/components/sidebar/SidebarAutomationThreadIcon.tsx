import { ClockIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarAutomationThreadIcon() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Automation thread"
            className="inline-flex shrink-0 items-center justify-center text-muted-foreground"
          />
        }
      >
        <ClockIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Automation thread</TooltipPopup>
    </Tooltip>
  );
}
