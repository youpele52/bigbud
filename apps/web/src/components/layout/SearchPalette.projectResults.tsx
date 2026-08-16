import type {
  ProjectCatalogScope,
  ProjectSummary,
} from "@bigbud/contracts/orchestration/orchestration.catalog";
import { isBuiltInChatsProject } from "@bigbud/contracts/constants/project.constant";
import { FolderIcon } from "lucide-react";

import { highlightMatch } from "./SearchPalette.logic";
import { CommandGroup, CommandGroupLabel, CommandItem } from "../ui/command";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar.menu";

export interface ProjectSearchResult {
  id: string;
  project: ProjectSummary;
  scope: ProjectCatalogScope;
  type: "project";
}

export function toProjectSearchResults(input: {
  localProjects: readonly ProjectSummary[];
  remoteProjects: readonly ProjectSummary[];
}): ProjectSearchResult[] {
  return [
    ...input.localProjects.map((project) => ({
      id: `project:${project.id}`,
      project,
      scope: "local" as const,
      type: "project" as const,
    })),
    ...input.remoteProjects.map((project) => ({
      id: `project:${project.id}`,
      project,
      scope: "remote" as const,
      type: "project" as const,
    })),
  ].filter(
    (result) => result.project.deletingAt === null && !isBuiltInChatsProject(result.project.id),
  );
}

interface ProjectSearchResultGroupProps {
  query: string;
  results: ProjectSearchResult[];
  visibleResults: ProjectSearchResult[];
  onSelect: (result: ProjectSearchResult) => void;
  onShowMore: () => void;
}

export function ProjectSearchResultGroup({
  query,
  results,
  visibleResults,
  onSelect,
  onShowMore,
}: ProjectSearchResultGroupProps) {
  if (results.length === 0) return null;

  return (
    <CommandGroup className="mt-2">
      <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
        Projects
      </CommandGroupLabel>
      {visibleResults.map((result) => {
        const highlight = highlightMatch(result.project.title, query);
        return (
          <CommandItem
            key={result.id}
            value={result.project.title.toLowerCase()}
            className="min-h-11 rounded-xl px-3 py-2"
            onSelect={() => onSelect(result)}
            onClick={() => onSelect(result)}
          >
            <div className="mr-3 text-muted-foreground/70">
              <FolderIcon className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">
                {highlight.hasMatch ? (
                  <>
                    {highlight.before}
                    <mark className="rounded-sm bg-primary/20 px-0.5 font-medium text-foreground">
                      {highlight.match}
                    </mark>
                    {highlight.after}
                  </>
                ) : (
                  result.project.title
                )}
              </div>
              <div className="truncate text-muted-foreground text-xs leading-5">
                {result.project.workspaceRoot ??
                  (result.scope === "local" ? "Local project" : "Remote project")}
              </div>
            </div>
          </CommandItem>
        );
      })}
      {results.length > visibleResults.length ? (
        <SidebarMenuSubItem className="w-full px-2 pt-1">
          <SidebarMenuSubButton
            render={<button type="button" />}
            size="sm"
            className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
            onClick={onShowMore}
          >
            <span>{`See more (${results.length - visibleResults.length})`}</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
    </CommandGroup>
  );
}
