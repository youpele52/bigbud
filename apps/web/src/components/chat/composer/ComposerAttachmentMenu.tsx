import { memo } from "react";
import { PaperclipIcon, PlusIcon, BotIcon, ZapIcon, BookOpenIcon } from "lucide-react";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export const ComposerAttachmentMenu = memo(function ComposerAttachmentMenu(props: {
  onAttachFiles: () => void;
  onOpenReadDialog: () => void;
  onCallAgent: () => void;
  onUseSkill: () => void;
  disabled?: boolean;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
                  aria-label="Add attachments, agents, or skills"
                  disabled={props.disabled}
                  type="button"
                >
                  <PlusIcon aria-hidden="true" className="size-4" />
                </Button>
              }
            />
          }
        />
        <TooltipPopup>Add files &amp; more</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="top">
        <MenuItem onClick={props.onAttachFiles}>
          <PaperclipIcon className="size-4 shrink-0" />
          Add photos and files
        </MenuItem>
        <MenuItem onClick={props.onOpenReadDialog}>
          <BookOpenIcon className="size-4 shrink-0" />
          Read document or URL
        </MenuItem>
        <MenuItem onClick={props.onCallAgent}>
          <BotIcon className="size-4 shrink-0" />
          Call agent
        </MenuItem>
        <MenuItem onClick={props.onUseSkill}>
          <ZapIcon className="size-4 shrink-0" />
          Use skill
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
