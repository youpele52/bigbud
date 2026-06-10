import * as React from "react";
import {
  DiffIcon,
  FoldersIcon,
  GitBranchIcon,
  GlobeIcon,
  NotebookTextIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { isElectron } from "~/config/env";
import { cn } from "~/lib/utils";
import { useBrowserPanelStore } from "~/stores/browser/browser.store";
import { requestRightPanel } from "~/stores/rightPanel/rightPanel.coordinator";
import {
  countRightPanelTabsByKind,
  getRightPanelTabKind,
  MAX_RIGHT_PANEL_BROWSER_TABS,
  type RightPanelTabId,
  type RightPanelTabKind,
  useRightPanelTabsStore,
} from "~/stores/rightPanel/rightPanelTabs.store";

const TAB_LABELS: Record<RightPanelTabKind, string> = {
  browser: "Browser",
  diff: "Diff",
  files: "Files",
  git: "Git",
  notes: "Notes",
  terminal: "Terminal",
};

const TAB_ICONS: Record<RightPanelTabKind, React.ComponentType<{ className?: string }>> = {
  browser: GlobeIcon,
  diff: DiffIcon,
  files: FoldersIcon,
  git: GitBranchIcon,
  notes: NotebookTextIcon,
  terminal: TerminalIcon,
};

interface RightPanelTabsProps {
  browserShortcutLabel: string | null;
  diffShortcutLabel?: string | null;
  filesShortcutLabel: string | null;
  gitShortcutLabel?: string | null;
  hasActiveProject: boolean;
  isGitRepo?: boolean;
  notesShortcutLabel?: string | null;
  onCloseBrowserTab: (tabId: RightPanelTabId) => void;
  onCloseDiff?: () => void;
  onCloseFiles: () => void;
  onCloseGit?: () => void;
  onCloseNotes?: () => void;
  onCloseTerminal: () => void;
  onOpenNewBrowserTab: () => void;
  onOpenDiff?: () => void;
  onOpenFiles: () => void;
  onOpenGit?: () => void;
  onOpenNotes?: () => void;
  onOpenTerminal: () => void;
  terminalAvailable: boolean;
  terminalShortcutLabel: string | null;
}

function TabMenuItem(props: {
  disabled?: boolean;
  kind: RightPanelTabKind;
  label?: string;
  onSelect: () => void;
  shortcutLabel: string | null;
}) {
  const Icon = TAB_ICONS[props.kind];

  return (
    <MenuItem disabled={props.disabled} onClick={props.onSelect}>
      <Icon className="size-3.5" />
      <span>{props.label ?? TAB_LABELS[props.kind]}</span>
      {props.shortcutLabel ? <MenuShortcut>{props.shortcutLabel}</MenuShortcut> : null}
    </MenuItem>
  );
}

function getBrowserTabFallbackLabel(url: string): string {
  try {
    return new URL(url).hostname || TAB_LABELS.browser;
  } catch {
    return TAB_LABELS.browser;
  }
}

function getTabLabel(
  tabId: RightPanelTabId,
  openTabs: ReadonlyArray<RightPanelTabId>,
  browserTabsById: Record<string, { title: string; url: string }>,
): string {
  const kind = getRightPanelTabKind(tabId);
  if (kind !== "browser") {
    return TAB_LABELS[kind];
  }

  const browserTab = browserTabsById[tabId];
  const resolvedLabel =
    browserTab?.title.trim() || getBrowserTabFallbackLabel(browserTab?.url ?? "");
  const matchingBrowserTabIds = openTabs.filter((openTabId) => {
    if (getRightPanelTabKind(openTabId) !== "browser") {
      return false;
    }

    const openBrowserTab = browserTabsById[openTabId];
    const openLabel =
      openBrowserTab?.title.trim() || getBrowserTabFallbackLabel(openBrowserTab?.url ?? "");

    return openLabel === resolvedLabel;
  });

  if (matchingBrowserTabIds.length <= 1) {
    return resolvedLabel;
  }

  const browserIndex = matchingBrowserTabIds.indexOf(tabId) + 1;
  return browserIndex > 1 ? `${resolvedLabel} ${browserIndex}` : resolvedLabel;
}

type DragEdge = "before" | "after";

export function RightPanelTabs({
  browserShortcutLabel,
  diffShortcutLabel,
  filesShortcutLabel,
  gitShortcutLabel,
  hasActiveProject,
  isGitRepo,
  notesShortcutLabel,
  onCloseBrowserTab,
  onCloseDiff,
  onCloseFiles,
  onCloseGit,
  onCloseNotes,
  onCloseTerminal,
  onOpenNewBrowserTab,
  onOpenDiff,
  onOpenFiles,
  onOpenGit,
  onOpenNotes,
  onOpenTerminal,
  terminalAvailable,
  terminalShortcutLabel,
}: RightPanelTabsProps) {
  const [draggedTabId, setDraggedTabId] = React.useState<RightPanelTabId | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{
    edge: DragEdge;
    tabId: RightPanelTabId;
  } | null>(null);
  const activeTabId = useRightPanelTabsStore((state) => state.activeTabId);
  const openTabs = useRightPanelTabsStore((state) => state.openTabs);
  const moveTab = useRightPanelTabsStore((state) => state.moveTab);
  const setActiveTab = useRightPanelTabsStore((state) => state.setActiveTab);
  const browserTabsById = useBrowserPanelStore((state) => state.tabsById);
  const browserTabLimitReached =
    countRightPanelTabsByKind(openTabs, "browser") >= MAX_RIGHT_PANEL_BROWSER_TABS;
  const browserTabMenuLabel = browserTabLimitReached
    ? `Browser (${MAX_RIGHT_PANEL_BROWSER_TABS} max)`
    : null;

  const closeTab = (tabId: RightPanelTabId) => {
    const kind = getRightPanelTabKind(tabId);

    switch (kind) {
      case "browser":
        onCloseBrowserTab(tabId);
        break;
      case "diff":
        onCloseDiff?.();
        break;
      case "files":
        onCloseFiles();
        break;
      case "git":
        onCloseGit?.();
        break;
      case "notes":
        onCloseNotes?.();
        break;
      case "terminal":
        onCloseTerminal();
        break;
    }
  };

  const clearDragState = () => {
    setDraggedTabId(null);
    setDropTarget(null);
  };

  return (
    <div
      className={cn(
        "flex items-center overflow-hidden border-b border-border bg-card/95 px-3",
        isElectron ? "h-[52px] pt-2" : "pt-2",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {openTabs.map((tabId, index) => {
          const kind = getRightPanelTabKind(tabId);
          const Icon = TAB_ICONS[kind];
          const isActive = activeTabId === tabId;
          const label = getTabLabel(tabId, openTabs, browserTabsById);

          return (
            <div
              key={tabId}
              draggable
              className={cn(
                "group relative grid h-9 w-[168px] max-w-[168px] shrink-0 grid-cols-[24px_minmax(0,1fr)_24px] items-center rounded-t-xl border border-b-0 px-1.5 text-xs shadow-sm",
                index > 0 && "-ml-px",
                isActive
                  ? "-mb-px border-border bg-background text-foreground"
                  : "cursor-pointer border-transparent bg-transparent text-muted-foreground hover:border-border/50 hover:bg-accent/30 hover:text-foreground",
                draggedTabId === tabId && "opacity-55",
              )}
              onDragEnd={clearDragState}
              onDragOver={(event) => {
                if (draggedTabId === null || draggedTabId === tabId) {
                  return;
                }

                event.preventDefault();
                event.dataTransfer.dropEffect = "move";

                const { left, width } = event.currentTarget.getBoundingClientRect();
                const edge: DragEdge = event.clientX - left < width / 2 ? "before" : "after";

                setDropTarget((current) =>
                  current?.tabId === tabId && current.edge === edge ? current : { tabId, edge },
                );
              }}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", tabId);
                setDraggedTabId(tabId);
                setDropTarget(null);
              }}
              onDrop={(event) => {
                if (
                  draggedTabId === null ||
                  draggedTabId === tabId ||
                  dropTarget?.tabId !== tabId
                ) {
                  clearDragState();
                  return;
                }

                event.preventDefault();
                moveTab(draggedTabId, tabId, dropTarget.edge);
                clearDragState();
              }}
            >
              {dropTarget?.tabId === tabId ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute bottom-1 top-1 z-10 w-0.5 rounded-full bg-primary/85",
                    dropTarget.edge === "before" ? "left-0" : "right-0",
                  )}
                />
              ) : null}
              <span aria-hidden="true" className="block size-4 justify-self-center" />
              <button
                type="button"
                draggable={false}
                className="flex min-w-0 items-center justify-center gap-1.5 px-1.5"
                title={label}
                onClick={() => {
                  setActiveTab(tabId);
                  requestRightPanel(kind);
                }}
              >
                <Icon className="size-3.5" />
                <span className="truncate text-xs font-medium">{label}</span>
              </button>
              <span className="flex items-center justify-center">
                <button
                  type="button"
                  draggable={false}
                  aria-label={`Close ${label} tab`}
                  className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground/70 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tabId);
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
            disabled={browserTabLimitReached}
            kind="browser"
            {...(browserTabMenuLabel ? { label: browserTabMenuLabel } : {})}
            onSelect={onOpenNewBrowserTab}
            shortcutLabel={browserShortcutLabel}
          />
          <TabMenuItem
            disabled={!hasActiveProject}
            kind="files"
            onSelect={onOpenFiles}
            shortcutLabel={filesShortcutLabel}
          />
          {onOpenNotes ? (
            <TabMenuItem
              kind="notes"
              onSelect={onOpenNotes}
              shortcutLabel={notesShortcutLabel ?? null}
            />
          ) : null}
          <TabMenuItem
            disabled={!terminalAvailable}
            kind="terminal"
            onSelect={onOpenTerminal}
            shortcutLabel={terminalShortcutLabel}
          />
          {onOpenGit && isGitRepo ? (
            <MenuItem onClick={onOpenGit}>
              <GitBranchIcon className="size-3.5" />
              <span>Git</span>
              {gitShortcutLabel ? <MenuShortcut>{gitShortcutLabel}</MenuShortcut> : null}
            </MenuItem>
          ) : null}
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
