import { FoldersIcon, GlobeIcon, PlusIcon, TerminalIcon, XIcon } from "lucide-react";

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
  files: "Files",
  terminal: "Terminal",
};

const TAB_ICONS: Record<RightPanelTabKind, React.ComponentType<{ className?: string }>> = {
  browser: GlobeIcon,
  files: FoldersIcon,
  terminal: TerminalIcon,
};

interface RightPanelTabsProps {
  browserShortcutLabel: string | null;
  filesShortcutLabel: string | null;
  hasActiveProject: boolean;
  onCloseBrowser: () => void;
  onCloseFiles: () => void;
  onCloseTerminal: () => void;
  onOpenBrowser: () => void;
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
  filesShortcutLabel,
  hasActiveProject,
  onCloseBrowser,
  onCloseFiles,
  onCloseTerminal,
  onOpenBrowser,
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
        "flex items-center gap-1 border-b border-border px-3",
        isElectron ? "h-[52px]" : "py-2",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {openTabs.map((kind) => {
          const Icon = TAB_ICONS[kind];

          return (
            <div
              key={kind}
              className={cn(
                "group inline-flex h-7 shrink-0 items-center rounded-md text-sm transition-colors",
                activeKind === kind
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
              )}
            >
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1.5 px-2"
                onClick={() => {
                  setActiveTab(kind);
                  requestRightPanel(kind);
                }}
              >
                <Icon className="size-3.5" />
                <span>{TAB_LABELS[kind]}</span>
              </button>
              <span className="inline-flex w-0 overflow-hidden transition-[width] duration-150 group-hover:w-5 group-focus-within:w-5">
                <button
                  type="button"
                  aria-label={`Close ${TAB_LABELS[kind]} tab`}
                  className="mr-1 inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground/80 transition-colors hover:bg-secondary hover:text-foreground"
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
            <Button aria-label="Open another right panel tab" size="icon-xs" variant="ghost">
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
        </MenuPopup>
      </Menu>
    </div>
  );
}
