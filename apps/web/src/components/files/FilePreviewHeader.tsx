import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { writeFilesPanelDragEntry } from "./filesPanel.dnd";
import { FILES_DRAWER_WIDTH_FACTOR, FILES_TREE_MIN_WIDTH } from "./FilesPanel.shared";

const HISTORY_AND_PADDING_WIDTH = 76;

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
      className="flex min-w-0 items-center gap-1 border-b border-border px-2 py-2"
      data-file-preview-header
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
      {/* Reserve the overlay's readable minimum and keep file close beside the name,
          in the uncovered left portion even for long breadcrumbs at the 320px panel minimum. */}
      <div
        className="flex min-w-0 flex-1 items-center gap-1"
        style={{
          maxWidth: `max(28px, min(calc(${(1 - FILES_DRAWER_WIDTH_FACTOR) * 100}% - ${HISTORY_AND_PADDING_WIDTH}px), calc(100% - ${FILES_TREE_MIN_WIDTH + HISTORY_AND_PADDING_WIDTH}px)))`,
        }}
        data-file-preview-identity
      >
        <div className="min-w-0" aria-label={absolutePath}>
          <div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs">
            {shortBreadcrumb.map((part, index) => (
              <span key={part.id} className="flex min-w-0 items-center gap-1">
                {index > 0 ? <span className="text-muted-foreground/45">&gt;</span> : null}
                {index === shortBreadcrumb.length - 1 ? (
                  <Tooltip>
                    <TooltipTrigger
                      delay={0}
                      render={
                        <span
                          draggable
                          className="cursor-grab truncate font-medium text-foreground active:cursor-grabbing"
                          onDragStart={(event) => {
                            writeFilesPanelDragEntry(event.dataTransfer, {
                              name: part.label,
                              path: absolutePath,
                              entryKind: "file",
                            });
                          }}
                        >
                          {part.label}
                        </span>
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
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            className="size-6 sm:size-6"
            aria-label="Close file"
            title="Close file"
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}
