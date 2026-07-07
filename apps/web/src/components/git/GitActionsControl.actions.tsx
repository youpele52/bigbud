import type { GitStatusResult } from "@bigbud/contracts";
import type { QueryClient } from "@tanstack/react-query";
import {
  CloudUploadIcon,
  DownloadIcon,
  GitBranchIcon,
  GitCommitIcon,
  HistoryIcon,
  ListMusicIcon,
  Rows3Icon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";

import {
  type GitActionIconName,
  type GitActionMenuItem,
  getMenuActionDisabledReason,
} from "./GitActionsControl.logic";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { invalidateGitStatusQuery } from "~/lib/gitReactQuery";

export interface GitActionsControlActionProps {
  gitCwd: string;
  queryClient: QueryClient;
  isRepo: boolean;
  isInitPending: boolean;
  isGitActionRunning: boolean;
  hasOriginRemote: boolean;
  gitStatusForActions: GitStatusResult | null;
  gitStatusError: Error | null;
  gitActionMenuItems: ReadonlyArray<GitActionMenuItem>;
  onOpenOrchestra?: (() => void) | undefined;
  onMenuItemSelect: (item: GitActionMenuItem) => void;
}

function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  if (icon === "pull") return <DownloadIcon />;
  if (icon === "fetch") return <DownloadIcon />;
  if (icon === "view_git_panel") return <Rows3Icon />;
  if (icon === "view_history") return <HistoryIcon />;
  if (icon === "discard_changes") return <Trash2Icon />;
  return <GitBranchIcon />;
}

function groupIndexForItem(item: GitActionMenuItem): number {
  if (item.id === "initialize_git") return 0;
  if (item.id === "commit" || item.id === "push" || item.id === "pull" || item.id === "fetch")
    return 1;
  if (item.id === "view_git_panel" || item.id === "view_history") return 2;
  return 3;
}

export function GitActionsControlActions(props: GitActionsControlActionProps) {
  const hasChanges = props.gitStatusForActions?.hasWorkingTreeChanges ?? false;
  const isAhead = (props.gitStatusForActions?.aheadCount ?? 0) > 0;
  const showStatusDot = hasChanges || isAhead;

  return (
    <Menu
      onOpenChange={(open) => {
        if (open) void invalidateGitStatusQuery(props.queryClient, props.gitCwd);
      }}
    >
      <MenuTrigger
        render={
          <Button
            aria-label="Quick actions"
            className="relative"
            disabled={props.isInitPending || props.isGitActionRunning}
            size="xs"
            variant="toolbar"
          >
            <Settings2Icon aria-hidden="true" className="size-3.5" />
            {showStatusDot && (
              <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary" />
            )}
          </Button>
        }
      />
      <MenuPopup align="end" className="w-full">
        <MenuSub>
          <MenuSubTrigger className="[&>span:last-child]:hidden">
            <GitBranchIcon aria-hidden="true" className="size-4" />
            Git
          </MenuSubTrigger>
          <MenuSubPopup className="w-full">
            {props.gitActionMenuItems.map((item, index) => {
              const previousItem = props.gitActionMenuItems[index - 1];
              const showSeparator =
                previousItem && groupIndexForItem(item) !== groupIndexForItem(previousItem);
              const disabledReason = getMenuActionDisabledReason({
                item,
                gitStatus: props.gitStatusForActions,
                isBusy: props.isGitActionRunning,
                hasOriginRemote: props.hasOriginRemote,
              });

              return (
                <div key={`${item.id}-${item.label}`}>
                  {showSeparator && <MenuSeparator />}
                  {item.disabled && disabledReason ? (
                    <Popover>
                      <PopoverTrigger
                        openOnHover
                        nativeButton={false}
                        render={<span className="block w-max cursor-not-allowed" />}
                      >
                        <MenuItem className="w-full" disabled variant={item.variant ?? "default"}>
                          <GitActionItemIcon icon={item.icon} />
                          {item.label}
                        </MenuItem>
                      </PopoverTrigger>
                      <PopoverPopup tooltipStyle side="left" align="center">
                        {disabledReason}
                      </PopoverPopup>
                    </Popover>
                  ) : (
                    <MenuItem
                      disabled={item.disabled}
                      variant={item.variant ?? "default"}
                      onClick={() => {
                        props.onMenuItemSelect(item);
                      }}
                    >
                      <GitActionItemIcon icon={item.icon} />
                      {item.label}
                    </MenuItem>
                  )}
                </div>
              );
            })}
            {props.gitStatusForActions?.branch === null && props.isRepo && (
              <p className="px-2 py-1.5 text-xs text-warning">
                Detached HEAD: create and checkout a branch to enable push and pull actions.
              </p>
            )}
            {props.gitStatusError && (
              <p className="px-2 py-1.5 text-xs text-destructive">{props.gitStatusError.message}</p>
            )}
          </MenuSubPopup>
        </MenuSub>
        {props.onOpenOrchestra ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={props.onOpenOrchestra}>
              <ListMusicIcon aria-hidden="true" className="size-4" />
              Orchestrate
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
