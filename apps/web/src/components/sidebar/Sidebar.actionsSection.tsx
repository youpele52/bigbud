import {
  BarChart3Icon,
  ClockIcon,
  Gamepad2,
  PlugIcon,
  SearchIcon,
  SquarePenIcon,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  closestCorners,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";
import { openBrowserPanel } from "../../stores/browser/browserPanel.actions";
import { useServerKeybindings } from "../../rpc/serverState";
import { readNativeApi } from "../../rpc/nativeApi";
import { shortcutLabelForCommand } from "../../models/keybindings";
import { useSearchStore } from "../../stores/ui/search.store";
import { useUiStateStore } from "../../stores/ui/ui.store";
import { Kbd } from "../ui/kbd";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import type { SidebarTopLevelHeaderProps } from "./SidebarSectionLabel";
import {
  SIDEBAR_ACTION_LABELS,
  sidebarVisualGroups,
  type SidebarActionId,
} from "./Sidebar.actions.logic";
import { buildSidebarItemMenuItems } from "./Sidebar.actions.menu";
import {
  effectiveHiddenSidebarActions,
  requestShowPlugins,
  usePluginGitAvailability,
} from "./Sidebar.actions.git";

interface SidebarActionsSectionProps {
  onNewChat: () => void;
  newThreadShortcutLabel: string | null | undefined;
  onOpenAutomations: () => void;
  onOpenUsage: () => void;
  onOpenPlugins?: () => void;
  onOpenGames: () => void;
  sections: Partial<
    Record<SidebarActionId, (headerProps: SidebarTopLevelHeaderProps) => ReactNode>
  >;
}

const ICONS = { plugins: PlugIcon, scheduled: ClockIcon, games: Gamepad2, usage: BarChart3Icon };
const ROW_CLASS =
  "group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-foreground/90 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const sidebarCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCorners(args);
};

function ActionRow({
  label,
  icon: Icon,
  onClick,
  onContextMenu,
  shortcut,
  dragHandleProps,
}: {
  label: string;
  icon: typeof SearchIcon;
  onClick: () => void;
  onContextMenu?: React.MouseEventHandler<HTMLButtonElement> | undefined;
  shortcut?: string | null | undefined;
  dragHandleProps?: SidebarTopLevelHeaderProps["dragHandleProps"];
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label === "New chat" ? label : `Open ${label.toLowerCase()}`}
            className={ROW_CLASS}
            onClick={onClick}
            onContextMenu={onContextMenu}
            {...dragHandleProps?.attributes}
            {...dragHandleProps?.listeners}
          />
        }
      >
        <Icon className={`${SIDEBAR_COMPACT_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/70`} />
        <span className="flex-1">{label}</span>
        {shortcut ? (
          <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
            {shortcut}
          </Kbd>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="right">{shortcut ? `${label} (${shortcut})` : label}</TooltipPopup>
    </Tooltip>
  );
}

function SortableTopLevelItem({
  id,
  children,
  onContextMenu,
}: {
  id: SidebarActionId;
  children: (headerProps: SidebarTopLevelHeaderProps) => ReactNode;
  onContextMenu: React.MouseEventHandler<HTMLElement>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? "relative z-10 rounded-md bg-sidebar-accent" : undefined}
    >
      {children({ onContextMenu, dragHandleProps: { attributes, listeners } })}
    </div>
  );
}

export function SidebarFixedActions({
  onNewChat,
  newThreadShortcutLabel,
  onContextMenu,
}: {
  onNewChat: () => void;
  newThreadShortcutLabel: string | null | undefined;
  onContextMenu?: React.MouseEventHandler<HTMLButtonElement>;
}) {
  const toggleSearchOpen = useSearchStore((state) => state.toggleSearchOpen);
  const keybindings = useServerKeybindings();
  return (
    <div className="sticky top-0 z-20 flex flex-col gap-0.5 bg-sidebar px-2 pt-2">
      <ActionRow
        label="New chat"
        icon={SquarePenIcon}
        onClick={onNewChat}
        shortcut={newThreadShortcutLabel}
        onContextMenu={onContextMenu}
      />
      <ActionRow
        label="Search"
        icon={SearchIcon}
        onClick={toggleSearchOpen}
        shortcut={shortcutLabelForCommand(keybindings, "search.toggle")}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}

export function SidebarActionsSection({
  onNewChat,
  newThreadShortcutLabel,
  onOpenAutomations,
  onOpenUsage,
  onOpenPlugins,
  onOpenGames,
  sections,
}: SidebarActionsSectionProps) {
  const order = useUiStateStore((state) => state.sidebarActionOrder);
  const hidden = useUiStateStore((state) => state.hiddenSidebarActions);
  const git = usePluginGitAvailability();
  const effectiveHidden = effectiveHiddenSidebarActions(hidden, git.status);
  const setHidden = useUiStateStore((state) => state.setSidebarActionHidden);
  const setAllHidden = useUiStateStore((state) => state.setAllSidebarActionsHidden);
  const reorderAction = useUiStateStore((state) => state.reorderSidebarAction);
  const moveToEdge = useUiStateStore((state) => state.moveSidebarActionToEdge);
  const resetOrder = useUiStateStore((state) => state.resetSidebarActionOrder);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const callbacks: Record<keyof typeof ICONS, () => void> = {
    plugins: () => onOpenPlugins?.(),
    scheduled: onOpenAutomations,
    games: onOpenGames,
    usage: onOpenUsage,
  };

  const showMissingGitPrompt = () => {
    toastManager.add({
      type: "warning",
      title: "Install Git to show Plugins",
      description:
        "Plugins need Git on this computer. Install Git, then try showing Plugins again.",
      actionProps: {
        children: "Install Git",
        onClick: () => openBrowserPanel({ url: "https://git-scm.com/install/" }),
      },
    });
  };
  const tryShowPlugins = async () => {
    await requestShowPlugins({
      check: git.check,
      show: () => setHidden("plugins", false),
      onMissing: showMissingGitPrompt,
      onUnknown: () =>
        toastManager.add({
          type: "warning",
          title: "Could not check Git",
          description: "Check the bigbud connection, then try showing Plugins again.",
        }),
    });
  };

  const showActionMenu = async (id: SidebarActionId | null, position: { x: number; y: number }) => {
    const api = readNativeApi();
    if (!api) return;
    const shown = order.filter(
      (entry) =>
        !effectiveHidden.includes(entry) && (entry in ICONS || sections[entry] !== undefined),
    );
    const index = id === null ? -1 : shown.indexOf(id);
    const menuItems = buildSidebarItemMenuItems({
      id,
      order,
      visible: shown,
      hidden: effectiveHidden,
    });
    const clicked = await api.contextMenu.show(menuItems, position);
    if (clicked === "hide" && id) setHidden(id, true);
    else if (clicked === "move-up" && id && index > 0) reorderAction(id, shown[index - 1]!);
    else if (clicked === "move-down" && id && index < shown.length - 1)
      reorderAction(id, shown[index + 1]!);
    else if (clicked === "move-top" && id && index > 0) moveToEdge(id, "top");
    else if (clicked === "move-bottom" && id && index < shown.length - 1) moveToEdge(id, "bottom");
    else if (clicked === "reset-order") resetOrder();
    else if (clicked === "show-all") {
      setAllHidden(false);
      if (effectiveHidden.includes("plugins")) void tryShowPlugins();
    } else if (clicked === "hide-all") setAllHidden(true);
    else if (clicked?.startsWith("show:")) {
      const hiddenId = effectiveHidden.find((entry) => `show:${entry}` === clicked);
      if (hiddenId === "plugins") void tryShowPlugins();
      else if (hiddenId) setHidden(hiddenId, false);
    }
  };
  const visible = order.filter(
    (id) => !effectiveHidden.includes(id) && (id in ICONS || sections[id] !== undefined),
  );
  const groups = sidebarVisualGroups(order, visible);
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const dragged = visible.find((id) => id === active.id);
      const target = visible.find((id) => id === over.id);
      if (dragged && target) reorderAction(dragged, target);
    }
  };
  const renderSortableItem = (id: SidebarActionId) => (
    <SortableTopLevelItem
      key={id}
      id={id}
      onContextMenu={(event) => {
        event.preventDefault();
        void showActionMenu(id, { x: event.clientX, y: event.clientY });
      }}
    >
      {(headerProps) => {
        const section = sections[id];
        if (section) return section(headerProps);
        const linkId = id as keyof typeof ICONS;
        return (
          <div className="px-2">
            <ActionRow
              label={SIDEBAR_ACTION_LABELS[id]}
              icon={ICONS[linkId]}
              onClick={callbacks[linkId]}
              onContextMenu={
                headerProps.onContextMenu as React.MouseEventHandler<HTMLButtonElement>
              }
              dragHandleProps={headerProps.dragHandleProps}
            />
          </div>
        );
      }}
    </SortableTopLevelItem>
  );

  return (
    <div className="flex flex-col gap-0.5 py-2">
      <SidebarFixedActions
        onNewChat={onNewChat}
        newThreadShortcutLabel={newThreadShortcutLabel}
        onContextMenu={(event) => {
          event.preventDefault();
          void showActionMenu(null, { x: event.clientX, y: event.clientY });
        }}
      />
      <DndContext
        sensors={sensors}
        collisionDetection={sidebarCollisionDetection}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={visible} strategy={verticalListSortingStrategy}>
          <div data-sidebar-visual-group="primary" className="flex flex-col gap-0.5">
            {groups.primary.map(renderSortableItem)}
          </div>
          <div data-sidebar-visual-group="secondary" className="mt-4 flex flex-col gap-0.5">
            {groups.secondary.map(renderSortableItem)}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
