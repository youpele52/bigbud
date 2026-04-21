import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { type RefObject } from "react";
import {
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
} from "@bigbud/contracts/settings";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarContent, SidebarGroup } from "../ui/sidebar";
import { ProjectSortMenu, type SortableProjectHandleProps } from "./SidebarProjectItem";
import { SidebarNewProjectFlow } from "./SidebarNewProjectFlow";
import { SidebarProjectList, type RenderedProject } from "./SidebarProjectList";
import { SidebarRenderedProjectItem, type RenderedProjectData } from "./SidebarRenderedProjectItem";
import type { RenderedProjectEntry, SharedProjectItemProps } from "./Sidebar.types";

interface DesktopUpdateButtonProps {
  action: "download" | "install" | "open-download" | "none";
  disabled: boolean;
  onClick: () => void;
}

interface SidebarProjectsSectionProps {
  // ARM64 warning banner
  showArm64IntelBuildWarning: boolean;
  arm64IntelBuildWarningDescription: string | null;
  desktopUpdateButton: DesktopUpdateButtonProps;
  // Projects header controls
  appSettingsSidebarProjectSortOrder: SidebarProjectSortOrder;
  appSettingsSidebarThreadSortOrder: SidebarThreadSortOrder;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  shouldShowProjectPathEntry: boolean;
  handleStartAddProject: () => void;
  // New project flow
  isElectron: boolean;
  newCwd: string;
  isPickingFolder: boolean;
  isAddingProject: boolean;
  addProjectError: string | null;
  addProjectInputRef: RefObject<HTMLInputElement | null>;
  onCwdChange: (cwd: string) => void;
  onClearError: () => void;
  onPickFolder: () => void;
  onAdd: () => void;
  onCancelAdd: () => void;
  // Project list
  renderedProjects: RenderedProjectEntry[];
  isManualProjectSorting: boolean;
  bootstrapComplete: boolean;
  hasProjects: boolean;
  onDragStart: (event: import("@dnd-kit/core").DragStartEvent) => void;
  onDragEnd: (event: import("@dnd-kit/core").DragEndEvent) => void;
  onDragCancel: (event: import("@dnd-kit/core").DragCancelEvent) => void;
  sharedProjectItemProps: SharedProjectItemProps;
}

/** The main projects panel in the sidebar: warning banner, sort controls, add-project flow, and the project list. */
export function SidebarProjectsSection({
  showArm64IntelBuildWarning,
  arm64IntelBuildWarningDescription,
  desktopUpdateButton,
  appSettingsSidebarProjectSortOrder,
  appSettingsSidebarThreadSortOrder,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
  shouldShowProjectPathEntry,
  handleStartAddProject,
  isElectron,
  newCwd,
  isPickingFolder,
  isAddingProject,
  addProjectError,
  addProjectInputRef,
  onCwdChange,
  onClearError,
  onPickFolder,
  onAdd,
  onCancelAdd,
  renderedProjects,
  isManualProjectSorting,
  bootstrapComplete,
  hasProjects,
  onDragStart,
  onDragEnd,
  onDragCancel,
  sharedProjectItemProps,
}: SidebarProjectsSectionProps) {
  return (
    <SidebarContent className="gap-0">
      {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
        <SidebarGroup className="px-2 pt-2 pb-0">
          <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
            <TriangleAlertIcon />
            <AlertTitle>Intel build on Apple Silicon</AlertTitle>
            <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
            {desktopUpdateButton.action !== "none" ? (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={desktopUpdateButton.disabled}
                  onClick={desktopUpdateButton.onClick}
                >
                  {desktopUpdateButton.action === "download"
                    ? "Download ARM build"
                    : "Install ARM build"}
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        </SidebarGroup>
      ) : null}
      <SidebarGroup className="px-2 py-2">
        <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Projects
          </span>
          <div className="flex items-center gap-1">
            <ProjectSortMenu
              projectSortOrder={appSettingsSidebarProjectSortOrder}
              threadSortOrder={appSettingsSidebarThreadSortOrder}
              onProjectSortOrderChange={onProjectSortOrderChange}
              onThreadSortOrderChange={onThreadSortOrderChange}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={shouldShowProjectPathEntry ? "Cancel new project" : "New project"}
                    aria-pressed={shouldShowProjectPathEntry}
                    className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                    onClick={handleStartAddProject}
                  />
                }
              >
                <PlusIcon
                  className={`size-3.5 transition-transform duration-150 ${
                    shouldShowProjectPathEntry ? "rotate-45" : "rotate-0"
                  }`}
                />
              </TooltipTrigger>
              <TooltipPopup side="right">
                {shouldShowProjectPathEntry ? "Cancel new project" : "New project"}
              </TooltipPopup>
            </Tooltip>
          </div>
        </div>

        {shouldShowProjectPathEntry && (
          <SidebarNewProjectFlow
            isElectron={isElectron}
            newCwd={newCwd}
            isPickingFolder={isPickingFolder}
            isAddingProject={isAddingProject}
            addProjectError={addProjectError}
            addProjectInputRef={addProjectInputRef}
            onCwdChange={onCwdChange}
            onClearError={onClearError}
            onPickFolder={onPickFolder}
            onAdd={onAdd}
            onCancel={onCancelAdd}
          />
        )}

        <SidebarProjectList
          renderedProjects={renderedProjects as unknown as RenderedProject[]}
          isManualSorting={isManualProjectSorting}
          bootstrapComplete={bootstrapComplete}
          hasProjects={hasProjects}
          showEmptyState={!shouldShowProjectPathEntry}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
          renderProjectItem={(rp, dragHandleProps) => (
            <SidebarRenderedProjectItem
              {...sharedProjectItemProps}
              {...(rp as unknown as RenderedProjectData)}
              dragHandleProps={dragHandleProps as SortableProjectHandleProps | null}
            />
          )}
        />
      </SidebarGroup>
    </SidebarContent>
  );
}
