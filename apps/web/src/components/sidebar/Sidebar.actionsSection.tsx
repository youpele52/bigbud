import { ClockIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import { useServerKeybindings } from "../../rpc/serverState";
import { shortcutLabelForCommand } from "../../models/keybindings";
import { useSearchStore } from "../../stores/ui/search.store";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";

interface SidebarActionsSectionProps {
  onNewChat: () => void;
  onOpenAutomations: () => void;
  newThreadShortcutLabel: string | null | undefined;
}

export function SidebarActionsSection({
  onNewChat,
  onOpenAutomations,
  newThreadShortcutLabel,
}: SidebarActionsSectionProps) {
  const toggleSearchOpen = useSearchStore((state) => state.toggleSearchOpen);
  const keybindings = useServerKeybindings();
  const searchShortcutLabel = shortcutLabelForCommand(keybindings, "search.toggle");

  return (
    <div className="flex flex-col gap-0.5 px-2 py-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="New chat"
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-medium text-foreground/90 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onNewChat}
            />
          }
        >
          <SquarePenIcon
            className={`${SIDEBAR_COMPACT_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/70`}
          />
          <span className="flex-1">New chat</span>
          {newThreadShortcutLabel ? (
            <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
              {newThreadShortcutLabel}
            </Kbd>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="right">
          {newThreadShortcutLabel ? `New chat (${newThreadShortcutLabel})` : "New chat"}
        </TooltipPopup>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Open search"
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-medium text-foreground/90 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={toggleSearchOpen}
            />
          }
        >
          <SearchIcon
            className={`${SIDEBAR_COMPACT_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/70`}
          />
          <span className="flex-1">Search</span>
          {searchShortcutLabel ? (
            <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
              {searchShortcutLabel}
            </Kbd>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="right">
          {searchShortcutLabel ? `Search (${searchShortcutLabel})` : "Search"}
        </TooltipPopup>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Open scheduled"
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-medium text-foreground/90 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onOpenAutomations}
            />
          }
        >
          <ClockIcon
            className={`${SIDEBAR_COMPACT_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/70`}
          />
          <span className="flex-1">Scheduled</span>
        </TooltipTrigger>
        <TooltipPopup side="right">Scheduled</TooltipPopup>
      </Tooltip>
    </div>
  );
}
