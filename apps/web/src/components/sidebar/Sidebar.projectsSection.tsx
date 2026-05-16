import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { type RefObject } from "react";
import {
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
} from "@bigbud/contracts/settings";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarGroup } from "../ui/sidebar";
import { ProjectSortMenu, type SortableProjectHandleProps } from "./SidebarProjectItem";
import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { SidebarNewProjectFlow } from "./SidebarNewProjectFlow";
import { SidebarProjectList, type RenderedProject } from "./SidebarProjectList";
import { SidebarRenderedProjectItem, type RenderedProjectData } from "./SidebarRenderedProjectItem";
import { isRemoteExecutionTargetId } from "./Sidebar.projects.logic";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import {
  SidebarSectionLabel,
  sidebarSectionLabelActionsClassName,
  sidebarSectionLabelRowClassName,
  sidebarSectionLabelTextClassName,
} from "./SidebarSectionLabel";
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
  openRemoteProjectDialog: () => void;
  onCloseMobileSidebar: () => void;
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
  openRemoteProjectDialog,
  onCloseMobileSidebar,
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
  onDragStart,
  onDragEnd,
  onDragCancel,
  sharedProjectItemProps,
}: SidebarProjectsSectionProps) {
  const localProjects = renderedProjects.filter(
    (entry) => !isRemoteExecutionTargetId(resolveWorkspaceExecutionTargetId(entry.project)),
  );
  const remoteProjects = renderedProjects.filter((entry) =>
    isRemoteExecutionTargetId(resolveWorkspaceExecutionTargetId(entry.project)),
  );

  return (
    <>
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
        <SidebarSectionLabel
          actions={
            <>
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
                      onClick={() => {
                        onCloseMobileSidebar();
                        handleStartAddProject();
                      }}
                    />
                  }
                >
                  <PlusIcon
                    className={`${SIDEBAR_COMPACT_ICON_SIZE_CLASS} transition-transform duration-150 ${
                      shouldShowProjectPathEntry ? "rotate-45" : "rotate-0"
                    }`}
                  />
                </TooltipTrigger>
                <TooltipPopup side="right">
                  {shouldShowProjectPathEntry ? "Cancel new project" : "New project"}
                </TooltipPopup>
              </Tooltip>
            </>
          }
        >
          Projects
        </SidebarSectionLabel>

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
          renderedProjects={localProjects as unknown as RenderedProject[]}
          isManualSorting={isManualProjectSorting}
          bootstrapComplete={bootstrapComplete}
          hasProjects={localProjects.length > 0}
          showEmptyState={!shouldShowProjectPathEntry && remoteProjects.length === 0}
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

        <div className="mt-3">
          <div className="-mx-2 px-4 pt-1.5 pb-2">
            <div className={sidebarSectionLabelRowClassName}>
              <div className={sidebarSectionLabelTextClassName}>Remote Projects</div>
              <div className={sidebarSectionLabelActionsClassName}>
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
                        aria-label="Add remote project"
                        className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                        onClick={() => {
                          onCloseMobileSidebar();
                          openRemoteProjectDialog();
                        }}
                      />
                    }
                  >
                    <PlusIcon className={SIDEBAR_COMPACT_ICON_SIZE_CLASS} />
                  </TooltipTrigger>
                  <TooltipPopup side="right">Add remote project</TooltipPopup>
                </Tooltip>
              </div>
            </div>
          </div>

          <SidebarProjectList
            renderedProjects={remoteProjects as unknown as RenderedProject[]}
            isManualSorting={isManualProjectSorting}
            bootstrapComplete={bootstrapComplete}
            hasProjects={remoteProjects.length > 0}
            showEmptyState={false}
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

          {bootstrapComplete &&
          remoteProjects.length === 0 &&
          (localProjects.length > 0 || shouldShowProjectPathEntry) ? (
            <div className="px-4 py-2 text-xs text-muted-foreground/60">No remote projects yet</div>
          ) : null}
        </div>
      </SidebarGroup>
    </>
  );
}
