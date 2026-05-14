import { BUILT_IN_CHATS_PROJECT_ID, isBuiltInChatsProject } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  FolderIcon,
  MessageSquareIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { resolveNewChatOptions } from "../../hooks/useHandleNewThread";
import { useSettings } from "../../hooks/useSettings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../models/keybindings";
import { useServerKeybindings } from "../../rpc/serverState";
import { useStore } from "../../stores/main";
import { selectThreadTerminalState, useTerminalStateStore } from "../../stores/terminal";
import { useCommandPaletteStore } from "../../stores/ui";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "../ui/command";

interface CommandPaletteProps {
  children: React.ReactNode;
}

interface PaletteItem {
  id: string;
  label: string;
  description: string;
  group: "actions" | "projects" | "threads";
  keywords: string;
  shortcut?: string | null;
  icon: React.ReactNode;
  onSelect: () => Promise<void> | void;
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function CommandPaletteDialogContent() {
  const navigate = useNavigate();
  const open = useCommandPaletteStore((store) => store.open);
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const keybindings = useServerKeybindings();
  const settings = useSettings();
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread } =
    useHandleNewThread();
  const projects = useStore(useShallow((store) => store.projects));
  const threads = useStore(useShallow((store) => store.threads));
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const actionItems: PaletteItem[] = [];
    const effectiveProjectId =
      activeThread?.projectId ?? activeDraftThread?.projectId ?? defaultProjectId;
    const chatsProject = projects.find((project) => isBuiltInChatsProject(project.id)) ?? null;
    const visibleProjects = projects.filter((project) => !isBuiltInChatsProject(project.id));
    const recentChatThreads = threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletingAt === null &&
        isBuiltInChatsProject(thread.projectId),
    );
    const paletteShortcut = shortcutLabelForCommand(keybindings, "commandPalette.toggle");

    if (effectiveProjectId) {
      actionItems.push({
        id: "action:new-thread",
        label: "New chat",
        description: "Create a fresh chat in the Chats section",
        group: "actions",
        keywords: "new chat create chats",
        shortcut: shortcutLabelForCommand(keybindings, "chat.new"),
        icon: <SquarePenIcon className="size-4" />,
        onSelect: async () => {
          await handleNewThread(BUILT_IN_CHATS_PROJECT_ID, resolveNewChatOptions());
        },
      });
      if (!isBuiltInChatsProject(effectiveProjectId)) {
        actionItems.push({
          id: "action:new-thread-local",
          label: "New local thread",
          description: "Create a new thread using the default environment mode",
          group: "actions",
          keywords: "new local thread chat create default environment",
          shortcut: shortcutLabelForCommand(keybindings, "chat.newLocal"),
          icon: <SquarePenIcon className="size-4" />,
          onSelect: async () => {
            await handleNewThread(effectiveProjectId, {
              envMode: settings.defaultThreadEnvMode,
            });
          },
        });
      }
    }

    actionItems.push({
      id: "action:settings",
      label: "Open settings",
      description: "Go to the settings screen",
      group: "actions",
      keywords: "settings preferences configuration keybindings",
      icon: <SettingsIcon className="size-4" />,
      onSelect: async () => {
        await navigate({ to: "/settings/general" });
      },
    });

    actionItems.push({
      id: "action:search-help",
      label: "Search commands, projects, and threads",
      description: `Use ${paletteShortcut ?? "the shortcut"} to reopen the palette quickly`,
      group: "actions",
      keywords: "help search commands projects threads palette",
      icon: <SearchIcon className="size-4" />,
      onSelect: () => undefined,
    });

    const projectItems = visibleProjects.map<PaletteItem>((project) => ({
      id: `project:${project.id}`,
      label: project.name,
      description: project.cwd ?? "Project",
      group: "projects",
      keywords: `${project.name} ${project.cwd ?? ""}`.toLowerCase(),
      icon: <FolderIcon className="size-4" />,
      onSelect: async () => {
        const latestThread = threads
          .filter(
            (thread) =>
              thread.projectId === project.id &&
              thread.archivedAt === null &&
              thread.deletingAt === null,
          )
          .toSorted((left, right) => {
            const rightTime = Date.parse(right.updatedAt ?? right.createdAt);
            const leftTime = Date.parse(left.updatedAt ?? left.createdAt);
            return rightTime - leftTime;
          })[0];

        if (latestThread) {
          await navigate({ to: "/$threadId", params: { threadId: latestThread.id } });
          return;
        }

        await handleNewThread(project.id, { envMode: settings.defaultThreadEnvMode });
      },
    }));

    const chatItems = recentChatThreads
      .toSorted((left, right) => {
        const rightTime = Date.parse(right.updatedAt ?? right.createdAt);
        const leftTime = Date.parse(left.updatedAt ?? left.createdAt);
        return rightTime - leftTime;
      })
      .slice(0, 12)
      .map<PaletteItem>((thread) => ({
        id: `chat:${thread.id}`,
        label: thread.title,
        description: chatsProject?.name ?? "Chats",
        group: "threads",
        keywords: `${thread.title} chats`.toLowerCase(),
        icon: <MessageSquareIcon className="size-4" />,
        onSelect: async () => {
          await navigate({ to: "/$threadId", params: { threadId: thread.id } });
        },
      }));

    const threadItems = threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.deletingAt === null &&
          !isBuiltInChatsProject(thread.projectId),
      )
      .toSorted((left, right) => {
        const rightTime = Date.parse(right.updatedAt ?? right.createdAt);
        const leftTime = Date.parse(left.updatedAt ?? left.createdAt);
        return rightTime - leftTime;
      })
      .slice(0, 12)
      .map<PaletteItem>((thread) => {
        const projectName =
          projects.find((project) => project.id === thread.projectId)?.name ?? "Project";
        return {
          id: `thread:${thread.id}`,
          label: thread.title,
          description: `${projectName}${thread.branch ? ` · ${thread.branch}` : ""}`,
          group: "threads",
          keywords: `${thread.title} ${projectName} ${thread.branch ?? ""}`.toLowerCase(),
          icon: <MessageSquareIcon className="size-4" />,
          onSelect: async () => {
            await navigate({ to: "/$threadId", params: { threadId: thread.id } });
          },
        };
      });

    return [...actionItems, ...projectItems, ...chatItems, ...threadItems];
  }, [
    activeDraftThread,
    activeThread,
    defaultProjectId,
    handleNewThread,
    keybindings,
    navigate,
    projects,
    settings.defaultThreadEnvMode,
    threads,
  ]);

  const normalizedQuery = normalizeQuery(query);
  const filteredItems = useMemo(() => {
    if (!normalizedQuery) {
      return items;
    }

    return items.filter((item) => {
      const haystack = `${item.label} ${item.description} ${item.keywords}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [items, normalizedQuery]);

  const groupedItems = useMemo(
    () => ({
      actions: filteredItems.filter((item) => item.group === "actions"),
      projects: filteredItems.filter((item) => item.group === "projects"),
      threads: filteredItems.filter((item) => item.group === "threads"),
    }),
    [filteredItems],
  );

  const handleSelect = (item: PaletteItem) => {
    setOpen(false);
    void Promise.resolve(item.onSelect());
  };

  const renderItem = (item: PaletteItem) => (
    <CommandItem
      key={item.id}
      value={`${item.label} ${item.description} ${item.keywords}`}
      onSelect={() => handleSelect(item)}
      onClick={() => handleSelect(item)}
    >
      <div className="mr-2 text-muted-foreground/80">{item.icon}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{item.label}</div>
        <div className="truncate text-muted-foreground text-xs">{item.description}</div>
      </div>
      {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
    </CommandItem>
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup
        aria-label="Command palette"
        className="overflow-hidden p-0"
        viewportClassName="items-start justify-start py-[max(--spacing(4),4vh)] sm:py-[10vh]"
        data-testid="command-palette"
      >
        <Command value={query} onValueChange={setQuery}>
          <CommandInput placeholder="Search commands, projects, and threads..." />
          <CommandPanel className="max-h-[min(28rem,70vh)]">
            <CommandList>
              <CommandEmpty>No matching items.</CommandEmpty>
              {groupedItems.actions.length > 0 ? (
                <CommandGroup>
                  <CommandGroupLabel>Actions</CommandGroupLabel>
                  {groupedItems.actions.map(renderItem)}
                </CommandGroup>
              ) : null}
              {groupedItems.projects.length > 0 ? (
                <CommandGroup>
                  <CommandGroupLabel>Projects</CommandGroupLabel>
                  {groupedItems.projects.map(renderItem)}
                </CommandGroup>
              ) : null}
              {groupedItems.threads.length > 0 ? (
                <CommandGroup>
                  <CommandGroupLabel>Recent Chats</CommandGroupLabel>
                  {groupedItems.threads.map(renderItem)}
                </CommandGroup>
              ) : null}
            </CommandList>
          </CommandPanel>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

export function CommandPalette({ children }: CommandPaletteProps) {
  const toggleOpen = useCommandPaletteStore((store) => store.toggleOpen);
  const open = useCommandPaletteStore((store) => store.open);
  const keybindings = useServerKeybindings();
  const { routeThreadId } = useHandleNewThread();
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, routeThreadId).terminalOpen
      : false,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (command !== "commandPalette.toggle") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      toggleOpen();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [keybindings, terminalOpen, toggleOpen]);

  return (
    <>
      {children}
      {open ? <CommandPaletteDialogContent /> : null}
    </>
  );
}
