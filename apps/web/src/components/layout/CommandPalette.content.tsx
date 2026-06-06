import {
  BUILT_IN_CHATS_PROJECT_ID,
  type ExecutionTargetId,
  isBuiltInChatsProject,
} from "@bigbud/contracts";
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

import { cn } from "~/lib/utils";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { resolveNewChatOptions } from "../../hooks/useHandleNewThread";
import { useSettings } from "../../hooks/useSettings";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { shortcutLabelForCommand } from "../../models/keybindings";
import { useDefaultChatCwd, useServerKeybindings } from "../../rpc/serverState";
import { useProjectById, useStore } from "../../stores/main";
import { useCommandPaletteStore, useUiStateStore } from "../../stores/ui";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "../ui/command";
import { CommandPaletteWorkspaceFiles } from "./CommandPalette.workspaceFiles";

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

function resolveWorkspaceSearchTarget(input: {
  activeThread: { projectId: string; worktreePath?: string | null } | null | undefined;
  selectedProject: { cwd?: string | null } | null | undefined;
  defaultChatCwd: string | null;
  selectedProjectExecutionTargetId?: ExecutionTargetId | null | undefined;
}): { workspaceRoot: string | null; workspaceExecutionTargetId?: ExecutionTargetId | undefined } {
  return {
    workspaceRoot:
      input.activeThread?.worktreePath ??
      input.selectedProject?.cwd ??
      input.defaultChatCwd ??
      null,
    workspaceExecutionTargetId: input.activeThread?.worktreePath
      ? undefined
      : (input.selectedProjectExecutionTargetId ?? undefined),
  };
}

export function CommandPaletteDialogContent() {
  const navigate = useNavigate();
  const open = useCommandPaletteStore((store) => store.open);
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const keybindings = useServerKeybindings();
  const settings = useSettings();
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread } =
    useHandleNewThread();
  const projects = useStore(useShallow((store) => store.projects));
  const threads = useStore(useShallow((store) => store.threads));
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const selectedProject = useProjectById(activeThread?.projectId ?? selectedProjectId ?? null);
  const defaultChatCwd = useDefaultChatCwd();
  const [query, setQuery] = useState("");

  const { workspaceRoot, workspaceExecutionTargetId } = resolveWorkspaceSearchTarget({
    activeThread,
    selectedProject,
    defaultChatCwd,
    selectedProjectExecutionTargetId: selectedProject
      ? resolveWorkspaceExecutionTargetId(selectedProject)
      : undefined,
  });

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
  const showResultsPanel = normalizedQuery.length > 0 || filteredItems.length > 0;

  const handleSelect = (item: PaletteItem) => {
    setOpen(false);
    void Promise.resolve(item.onSelect());
  };

  const renderItem = (item: PaletteItem) => (
    <CommandItem
      key={item.id}
      value={`${item.label} ${item.description} ${item.keywords}`}
      className="min-h-11 rounded-xl px-3 py-2"
      onSelect={() => handleSelect(item)}
      onClick={() => handleSelect(item)}
    >
      <div className="mr-3 text-muted-foreground/70">{item.icon}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{item.label}</div>
        <div className="truncate text-muted-foreground text-xs leading-5">{item.description}</div>
      </div>
      {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
    </CommandItem>
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup
        aria-label="Command palette"
        className="mx-auto w-full max-w-[32rem] overflow-visible border-0 bg-transparent p-0 shadow-none before:hidden"
        viewportClassName="items-center justify-center"
        data-testid="command-palette"
      >
        <Command value={query} onValueChange={setQuery}>
          <div className="group rounded-[22px] p-px transition-colors duration-200">
            <div className="rounded-[20px] border border-border bg-card transition-colors duration-200 has-focus-visible:border-ring/45">
              <div
                className={cn(
                  "px-3 py-2 sm:px-4 sm:py-3",
                  !showResultsPanel && "[&_[data-slot=searchbar]]:border-b-0",
                )}
              >
                <CommandInput
                  placeholder="Search commands, projects, and threads..."
                  className="h-8 px-0 text-sm placeholder:text-muted-foreground/65"
                />
              </div>

              {showResultsPanel ? (
                <CommandPanel className="max-h-[min(28rem,55vh)] rounded-t-none border-0 bg-transparent shadow-none [clip-path:none] before:hidden">
                  <CommandList
                    className="px-2 pb-2 sm:px-3 sm:pb-3"
                    scrollAreaClassName="max-h-[min(28rem,55vh)]"
                  >
                    {groupedItems.actions.length > 0 ? (
                      <CommandGroup>
                        <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
                          Actions
                        </CommandGroupLabel>
                        {groupedItems.actions.map(renderItem)}
                      </CommandGroup>
                    ) : null}
                    {groupedItems.projects.length > 0 ? (
                      <CommandGroup
                        className={groupedItems.actions.length > 0 ? "mt-2" : undefined}
                      >
                        <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
                          Projects
                        </CommandGroupLabel>
                        {groupedItems.projects.map(renderItem)}
                      </CommandGroup>
                    ) : null}
                    {groupedItems.threads.length > 0 ? (
                      <CommandGroup
                        className={
                          groupedItems.actions.length > 0 || groupedItems.projects.length > 0
                            ? "mt-2"
                            : undefined
                        }
                      >
                        <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
                          Recent chats
                        </CommandGroupLabel>
                        {groupedItems.threads.map(renderItem)}
                      </CommandGroup>
                    ) : null}
                    <CommandPaletteWorkspaceFiles
                      open={open}
                      normalizedQuery={normalizedQuery}
                      workspaceRoot={workspaceRoot}
                      workspaceExecutionTargetId={workspaceExecutionTargetId}
                      onBeforeOpenFile={() => setOpen(false)}
                      withTopMargin={
                        groupedItems.actions.length > 0 ||
                        groupedItems.projects.length > 0 ||
                        groupedItems.threads.length > 0
                      }
                    />
                  </CommandList>
                </CommandPanel>
              ) : null}
            </div>
          </div>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
