import { LoaderIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "./button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/** Small ghost refresh button with a tooltip; spins while `busy`. */
export function RefreshIconButton({
  label,
  busy,
  disabled = false,
  onClick,
}: {
  /** Used for both the tooltip and the accessible name. */
  label: string;
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            disabled={busy || disabled}
            onClick={onClick}
            aria-label={label}
            aria-busy={busy}
          >
            {busy ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
