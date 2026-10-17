import { Cards02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "../../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  TERMINAL_LAYOUT_LABELS,
  type TerminalLayoutMode,
} from "../view/chat-view/terminalLayout.logic";

interface ChatLayoutMenuProps {
  mode: TerminalLayoutMode;
  onSelectLayout: (mode: TerminalLayoutMode) => void;
}

export function ChatLayoutMenu({ mode, onSelectLayout }: ChatLayoutMenuProps) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button aria-label="Chat layout" className="shrink-0" size="xs" variant="toolbar" />
              }
            />
          }
        >
          <HugeiconsIcon
            aria-hidden="true"
            className="size-3.5"
            icon={Cards02Icon}
            size={14}
            strokeWidth={1.5}
          />
        </TooltipTrigger>
        <TooltipPopup
          side="bottom"
          className="pointer-events-none"
          positionerClassName="pointer-events-none"
        >
          Chat layout: {TERMINAL_LAYOUT_LABELS[mode]}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <MenuRadioGroup
          value={mode}
          onValueChange={(value) => onSelectLayout(value as TerminalLayoutMode)}
        >
          {(Object.entries(TERMINAL_LAYOUT_LABELS) as Array<[TerminalLayoutMode, string]>).map(
            ([value, label]) => (
              <MenuRadioItem key={value} value={value} closeOnClick className="text-sm">
                {label}
              </MenuRadioItem>
            ),
          )}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
