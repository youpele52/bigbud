import { FileAddIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ProjectEntryActions } from "@bigbud/contracts/workspace/projectEntryMutation";

import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { entryActionDisabledReason, type NewEntryKind } from "./FilesPanel.entryActions.logic";

interface FilesPanelAddMenuProps {
  readonly actions: ProjectEntryActions | null;
  readonly onChoose: (kind: NewEntryKind) => void;
  /** Re-reads the actions when the menu opens (an agent may have been updated meanwhile). */
  readonly onOpen?: () => void;
}

const CHOICES: ReadonlyArray<{ readonly kind: NewEntryKind; readonly label: string }> = [
  { kind: "file", label: "New file" },
  { kind: "folder", label: "New folder" },
];

/** The Files header add button: asks for a file or a folder, then the tree shows a name input. */
export function FilesPanelAddMenu({ actions, onChoose, onOpen }: FilesPanelAddMenuProps) {
  const reasons = {
    file: entryActionDisabledReason(actions?.createFile),
    folder: entryActionDisabledReason(actions?.createFolder),
  } as const;
  const label = "New file or folder";
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  className="shrink-0 [-webkit-app-region:no-drag]"
                  data-files-add-entry
                  aria-label={label}
                  variant="toolbar"
                  size="icon-xs"
                >
                  <HugeiconsIcon
                    icon={FileAddIcon}
                    size={16}
                    strokeWidth={1.5}
                    className="size-4"
                    aria-hidden="true"
                  />
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="max-w-72">
        {CHOICES.map(({ kind, label: choiceLabel }) => {
          const reason = reasons[kind];
          return (
            <DropdownMenuItem
              key={kind}
              className="text-sm"
              data-files-add-choice={kind}
              disabled={reason !== null}
              title={reason ?? undefined}
              onClick={() => onChoose(kind)}
            >
              <span className="flex flex-col">
                <span>{choiceLabel}</span>
                {reason ? (
                  <span className="text-xs whitespace-normal text-muted-foreground">{reason}</span>
                ) : null}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
