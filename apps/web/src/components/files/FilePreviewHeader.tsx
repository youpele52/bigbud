import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface FilePreviewHeaderProps {
  readonly breadcrumb: ReadonlyArray<{ id: string; label: string }>;
  readonly absolutePath: string;
  readonly canNavigateBack: boolean;
  readonly canNavigateForward: boolean;
  readonly onNavigateBack: () => void;
  readonly onNavigateForward: () => void;
  readonly onClose?: (() => void) | undefined;
  readonly onContextMenu?: ((event: React.MouseEvent<HTMLDivElement>) => void) | undefined;
  readonly actions?: React.ReactNode;
}

export function FilePreviewHeader({
  breadcrumb,
  absolutePath,
  canNavigateBack,
  canNavigateForward,
  onNavigateBack,
  onNavigateForward,
  onClose,
  onContextMenu,
  actions,
}: FilePreviewHeaderProps) {
  const shortBreadcrumb = breadcrumb.length > 1 ? breadcrumb.slice(-2) : breadcrumb;
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-center gap-2 border-b border-border px-2 py-2"
      onContextMenu={onContextMenu}
    >
      <div className="flex shrink-0 items-center gap-1 justify-self-start">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={!canNavigateBack}
          onClick={onNavigateBack}
          aria-label="Back"
          title="Back"
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={!canNavigateForward}
          onClick={onNavigateForward}
          aria-label="Forward"
          title="Forward"
        >
          <ArrowRightIcon />
        </Button>
      </div>
      <div className="min-w-0 max-w-full justify-self-center" aria-label={absolutePath}>
        <div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs">
          {shortBreadcrumb.map((part, index) => (
            <span key={part.id} className="flex min-w-0 items-center gap-1">
              {index > 0 ? <span className="text-muted-foreground/45">&gt;</span> : null}
              {index === shortBreadcrumb.length - 1 ? (
                <Tooltip>
                  <TooltipTrigger
                    delay={0}
                    render={
                      <span className="truncate font-medium text-foreground">{part.label}</span>
                    }
                  />
                  <TooltipPopup>{absolutePath}</TooltipPopup>
                </Tooltip>
              ) : (
                <span className={cn("truncate", "text-muted-foreground/75")}>{part.label}</span>
              )}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 justify-self-end">
        {actions}
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
