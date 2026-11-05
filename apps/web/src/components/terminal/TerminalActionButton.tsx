import { type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}

export function TerminalActionButton({
  label,
  className,
  onClick,
  children,
}: TerminalActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
        positionerClassName="pointer-events-none"
      >
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}
