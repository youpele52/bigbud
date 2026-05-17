import type { GitStatusResult } from "@bigbud/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, CloudUploadIcon, GitCommitIcon, InfoIcon } from "lucide-react";

import { GitHubIcon } from "../Icons";
import {
  type GitActionIconName,
  type GitActionMenuItem,
  type GitQuickAction,
  getMenuActionDisabledReason,
} from "./GitActionsControl.logic";
import { Button } from "~/components/ui/button";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
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
  quickAction: GitQuickAction;
  quickActionDisabledReason: string | null;
  onInit: () => void;
  onRunQuickAction: () => void;
  onOpenDialogForMenuItem: (item: GitActionMenuItem) => void;
}

function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <GitHubIcon />;
}

function GitQuickActionIcon({ quickAction }: { quickAction: GitQuickAction }) {
  const iconClassName = "size-3.5";
  if (quickAction.kind === "open_pr") return <GitHubIcon className={iconClassName} />;
  if (quickAction.kind === "run_pull") return <InfoIcon className={iconClassName} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={iconClassName} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={iconClassName} />;
    }
    return <GitHubIcon className={iconClassName} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={iconClassName} />;
  return <InfoIcon className={iconClassName} />;
}

export function GitActionsControlActions(props: GitActionsControlActionProps) {
  if (!props.isRepo) {
    return (
      <Button variant="toolbar" size="xs" disabled={props.isInitPending} onClick={props.onInit}>
        {props.isInitPending ? "Initializing..." : "Initialize Git"}
      </Button>
    );
  }

  return (
    <Group aria-label="Git actions" className="shrink-0">
      {props.quickActionDisabledReason ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <Button
                aria-disabled="true"
                className="cursor-not-allowed rounded-e-none border-e-0 opacity-64 before:rounded-e-none"
                size="xs"
                variant="toolbar"
              />
            }
          >
            <GitQuickActionIcon quickAction={props.quickAction} />
            <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
              {props.quickAction.label}
            </span>
          </PopoverTrigger>
          <PopoverPopup tooltipStyle side="bottom" align="start">
            {props.quickActionDisabledReason}
          </PopoverPopup>
        </Popover>
      ) : (
        <Button
          variant="toolbar"
          size="xs"
          disabled={props.isGitActionRunning || props.quickAction.disabled}
          onClick={props.onRunQuickAction}
        >
          <GitQuickActionIcon quickAction={props.quickAction} />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            {props.quickAction.label}
          </span>
        </Button>
      )}
      <GroupSeparator className="hidden @3xl/header-actions:block" />
      <Menu
        onOpenChange={(open) => {
          if (open) void invalidateGitStatusQuery(props.queryClient, props.gitCwd);
        }}
      >
        <MenuTrigger
          render={<Button aria-label="Git action options" size="icon-xs" variant="toolbar" />}
          disabled={props.isGitActionRunning}
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-full">
          {props.gitActionMenuItems.map((item) => {
            const disabledReason = getMenuActionDisabledReason({
              item,
              gitStatus: props.gitStatusForActions,
              isBusy: props.isGitActionRunning,
              hasOriginRemote: props.hasOriginRemote,
            });
            if (item.disabled && disabledReason) {
              return (
                <Popover key={`${item.id}-${item.label}`}>
                  <PopoverTrigger
                    openOnHover
                    nativeButton={false}
                    render={<span className="block w-max cursor-not-allowed" />}
                  >
                    <MenuItem className="w-full" disabled>
                      <GitActionItemIcon icon={item.icon} />
                      {item.label}
                    </MenuItem>
                  </PopoverTrigger>
                  <PopoverPopup tooltipStyle side="left" align="center">
                    {disabledReason}
                  </PopoverPopup>
                </Popover>
              );
            }

            return (
              <MenuItem
                key={`${item.id}-${item.label}`}
                disabled={item.disabled}
                onClick={() => {
                  props.onOpenDialogForMenuItem(item);
                }}
              >
                <GitActionItemIcon icon={item.icon} />
                {item.label}
              </MenuItem>
            );
          })}
          {props.gitStatusForActions?.branch === null && (
            <p className="px-2 py-1.5 text-xs text-warning">
              Detached HEAD: create and checkout a branch to enable push and PR actions.
            </p>
          )}
          {props.gitStatusForActions &&
            props.gitStatusForActions.branch !== null &&
            !props.gitStatusForActions.hasWorkingTreeChanges &&
            props.gitStatusForActions.behindCount > 0 &&
            props.gitStatusForActions.aheadCount === 0 && (
              <p className="px-2 py-1.5 text-xs text-warning">
                Behind upstream. Pull/rebase first.
              </p>
            )}
          {props.gitStatusError && (
            <p className="px-2 py-1.5 text-xs text-destructive">{props.gitStatusError.message}</p>
          )}
        </MenuPopup>
      </Menu>
    </Group>
  );
}
