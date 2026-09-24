import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SharedProjectItemProps } from "./Sidebar.types";

vi.mock("./SidebarProjectItem", () => ({ ProjectSortMenu: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children: React.ReactNode;
    render: React.ReactNode;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));

import { SidebarProjectsSection } from "./Sidebar.projectsSection";

const props: Omit<Parameters<typeof SidebarProjectsSection>[0], "scope"> = {
  showArm64IntelBuildWarning: false,
  arm64IntelBuildWarningDescription: null,
  desktopUpdateButton: { action: "none", disabled: false, onClick: vi.fn() },
  appSettingsSidebarProjectSortOrder: "manual",
  appSettingsSidebarThreadSortOrder: "updated_at",
  onProjectSortOrderChange: vi.fn(),
  onThreadSortOrderChange: vi.fn(),
  shouldShowProjectPathEntry: false,
  handleStartAddProject: vi.fn(),
  openRemoteProjectDialog: vi.fn(),
  onCloseMobileSidebar: vi.fn(),
  isElectron: false,
  newCwd: "",
  isPickingFolder: false,
  isAddingProject: false,
  addProjectError: null,
  addProjectInputRef: { current: null },
  onCwdChange: vi.fn(),
  onClearError: vi.fn(),
  onPickFolder: vi.fn(),
  onAdd: vi.fn(),
  onCancelAdd: vi.fn(),
  renderedProjects: [],
  isExpanded: false,
  onExpandedChange: vi.fn(),
  isRemoteProjectsExpanded: false,
  onRemoteProjectsExpandedChange: vi.fn(),
  isManualProjectSorting: false,
  onDragStart: vi.fn(),
  onDragEnd: vi.fn(),
  onDragCancel: vi.fn(),
  sharedProjectItemProps: {} as SharedProjectItemProps,
};

describe("top-level project sections", () => {
  it("renders local and remote headings independently", () => {
    const local = renderToStaticMarkup(<SidebarProjectsSection {...props} scope="local" />);
    const remote = renderToStaticMarkup(<SidebarProjectsSection {...props} scope="remote" />);
    expect(local).toContain("Projects");
    expect(local).not.toContain("Remote Projects");
    expect(remote).toContain("Remote Projects");
    expect(remote).not.toContain("No projects yet");
  });
});
