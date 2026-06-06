import type { ExecutionTargetId } from "@bigbud/contracts";
import { useQuery } from "@tanstack/react-query";
import { FileIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { CommandGroup, CommandGroupLabel, CommandItem } from "../ui/command";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar.menu";
import { openPathFromChat } from "../../stores/files/filesPanel.open";
import { joinWorkspaceEntryPath } from "../files/filesPanel.dnd";

const INITIAL_VISIBLE_FILE_COUNT = 10;
const FILE_SEARCH_RESULT_LIMIT = 80;

interface CommandPaletteWorkspaceFilesProps {
  open: boolean;
  normalizedQuery: string;
  workspaceRoot: string | null;
  workspaceExecutionTargetId?: ExecutionTargetId | null | undefined;
  onBeforeOpenFile: () => void;
  withTopMargin?: boolean;
}

export function CommandPaletteWorkspaceFiles({
  open,
  normalizedQuery,
  workspaceRoot,
  workspaceExecutionTargetId,
  onBeforeOpenFile,
  withTopMargin,
}: CommandPaletteWorkspaceFilesProps) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_FILE_COUNT);

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_FILE_COUNT);
  }, [normalizedQuery, open, workspaceRoot]);

  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: workspaceRoot,
      executionTargetId: workspaceExecutionTargetId,
      query: normalizedQuery,
      enabled: open && normalizedQuery.length > 0,
      limit: FILE_SEARCH_RESULT_LIMIT,
    }),
  );

  const fileEntries = useMemo(
    () => (workspaceEntriesQuery.data?.entries ?? []).filter((entry) => entry.kind === "file"),
    [workspaceEntriesQuery.data?.entries],
  );

  const visibleEntries = fileEntries.slice(0, visibleCount);
  const hasMore = fileEntries.length > visibleCount;

  if (normalizedQuery.length === 0 || fileEntries.length === 0 || !workspaceRoot) {
    return null;
  }

  return (
    <CommandGroup className={withTopMargin ? "mt-2" : undefined}>
      <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
        Files
      </CommandGroupLabel>
      {visibleEntries.map((entry) => (
        <CommandItem
          key={entry.path}
          value={entry.path.toLowerCase()}
          className="min-h-11 rounded-xl px-3 py-2"
          onSelect={() => {
            onBeforeOpenFile();
            void openPathFromChat(
              joinWorkspaceEntryPath(workspaceRoot, entry.path),
              workspaceRoot,
            ).catch((error) => {
              console.error("Failed to open file:", error);
            });
          }}
          onClick={() => {
            onBeforeOpenFile();
            void openPathFromChat(
              joinWorkspaceEntryPath(workspaceRoot, entry.path),
              workspaceRoot,
            ).catch((error) => {
              console.error("Failed to open file:", error);
            });
          }}
        >
          <div className="mr-3 text-muted-foreground/70">
            <FileIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{entry.path.split("/").at(-1) ?? entry.path}</div>
            <div className="truncate text-muted-foreground text-xs leading-5">{entry.path}</div>
          </div>
        </CommandItem>
      ))}
      {hasMore ? (
        <SidebarMenuSubItem className="w-full px-2 pt-1">
          <SidebarMenuSubButton
            render={<button type="button" />}
            size="sm"
            className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
            onClick={() => setVisibleCount((current) => current + INITIAL_VISIBLE_FILE_COUNT)}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span>{`See more (${fileEntries.length - visibleEntries.length})`}</span>
            </span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
    </CommandGroup>
  );
}
