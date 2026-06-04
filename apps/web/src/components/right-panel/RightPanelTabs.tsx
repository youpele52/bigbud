import { DiffIcon, FoldersIcon, GlobeIcon, PlusIcon, TerminalIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { isElectron } from "~/config/env";
import { cn } from "~/lib/utils";
import { requestRightPanel } from "~/stores/rightPanel/rightPanel.coordinator";
import {
  type RightPanelTabKind,
  useRightPanelTabsStore,
} from "~/stores/rightPanel/rightPanelTabs.store";

const TAB_LABELS: Record<RightPanelTabKind, string> = {
  browser: "Browser",
  diff: "Diff",
  files: "Files",
  terminal: "Terminal",
};

const TAB_ICONS: Record<RightPanelTabKind, React.ComponentType<{ className?: string }>> = {
  browser: GlobeIcon,
  diff: DiffIcon,
  files: FoldersIcon,
  terminal: TerminalIcon,
};

interface RightPanelTabsProps {
  browserShortcutLabel: string | null;
  diffShortcutLabel?: string | null;
  filesShortcutLabel: string | null;
  hasActiveProject: boolean;
  isGitRepo?: boolean;
  onCloseBrowser: () => void;
  onCloseDiff?: () => void;
  onCloseFiles: () => void;
  onCloseTerminal: () => void;
  onOpenBrowser: () => void;
  onOpenDiff?: () => void;
  onOpenFiles: () => void;
  onOpenTerminal: () => void;
  terminalAvailable: boolean;
  terminalShortcutLabel: string | null;
}

function TabMenuItem(props: {
  disabled?: boolean;
  kind: RightPanelTabKind;
  onSelect: () => void;
  shortcutLabel: string | null;
}) {
  const Icon = TAB_ICONS[props.kind];

  return (
    <MenuItem disabled={props.disabled} onClick={props.onSelect}>
      <Icon className="size-3.5" />
      <span>{TAB_LABELS[props.kind]}</span>
      {props.shortcutLabel ? <MenuShortcut>{props.shortcutLabel}</MenuShortcut> : null}
    </MenuItem>
  );
}

export function RightPanelTabs({
  browserShortcutLabel,
  diffShortcutLabel,
  filesShortcutLabel,
  hasActiveProject,
  isGitRepo,
  onCloseBrowser,
  onCloseDiff,
  onCloseFiles,
  onCloseTerminal,
  onOpenBrowser,
  onOpenDiff,
  onOpenFiles,
  onOpenTerminal,
  terminalAvailable,
  terminalShortcutLabel,
}: RightPanelTabsProps) {
  const activeKind = useRightPanelTabsStore((state) => state.activeKind);
  const openTabs = useRightPanelTabsStore((state) => state.openTabs);
  const setActiveTab = useRightPanelTabsStore((state) => state.setActiveTab);

  const closeTab = (kind: RightPanelTabKind) => {
    switch (kind) {
      case "browser":
        onCloseBrowser();
        break;
      case "diff":
        onCloseDiff?.();
        break;
      case "files":
        onCloseFiles();
        break;
      case "terminal":
        onCloseTerminal();
        break;
    }
  };

  return (
    <div
      className={cn(
        "flex items-center overflow-hidden border-b border-border bg-card/95 px-3",
        isElectron ? "h-[52px] pt-2" : "pt-2",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {openTabs.map((kind, index) => {
          const Icon = TAB_ICONS[kind];
          const isActive = activeKind === kind;

          return (
            <div
              key={kind}
              className={cn(
                "group grid h-9 min-w-[132px] shrink-0 grid-cols-[24px_auto_24px] items-center rounded-t-xl border border-b-0 px-1.5 text-xs shadow-sm",
                index > 0 && "-ml-px",
                isActive
                  ? "-mb-px border-border bg-background text-foreground"
                  : "border-transparent bg-transparent text-muted-foreground hover:border-border/50 hover:bg-accent/30 hover:text-foreground cursor-pointer",
              )}
            >
              <span aria-hidden="true" className="block size-4 justify-self-center" />
              <button
                type="button"
                className="flex items-center justify-center gap-1.5 px-1.5"
                onClick={() => {
                  setActiveTab(kind);
                  requestRightPanel(kind);
                }}
              >
                <Icon className="size-3.5" />
                <span className="text-xs font-medium">{TAB_LABELS[kind]}</span>
              </button>
              <span className="flex items-center justify-center">
                <button
                  type="button"
                  aria-label={`Close ${TAB_LABELS[kind]} tab`}
                  className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground/70 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(kind);
                  }}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label="Open another right panel tab"
              className="mb-1 ml-2 rounded-md border border-transparent hover:border-border/60 hover:bg-accent/40"
              size="icon-xs"
              variant="ghost"
            >
              <PlusIcon className="size-3.5" />
            </Button>
          }
        />
        <MenuPopup align="end" className="min-w-40">
          <TabMenuItem
            kind="browser"
            onSelect={onOpenBrowser}
            shortcutLabel={browserShortcutLabel}
          />
          <TabMenuItem
            disabled={!hasActiveProject}
            kind="files"
            onSelect={onOpenFiles}
            shortcutLabel={filesShortcutLabel}
          />
          <TabMenuItem
            disabled={!terminalAvailable}
            kind="terminal"
            onSelect={onOpenTerminal}
            shortcutLabel={terminalShortcutLabel}
          />
          {onOpenDiff && (
            <MenuItem disabled={!isGitRepo} onClick={onOpenDiff}>
              <DiffIcon className="size-3.5" />
              <span>Diff</span>
              {diffShortcutLabel ? <MenuShortcut>{diffShortcutLabel}</MenuShortcut> : null}
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </div>
  );
}
