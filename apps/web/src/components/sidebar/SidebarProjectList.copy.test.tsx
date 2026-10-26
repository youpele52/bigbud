import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  projectCatalogCursorByScope: { local: "next", remote: "next" },
  projectCatalogLoadingByScope: { local: false, remote: false },
  projectCatalogRemainingCountByScope: { local: 7, remote: 7 },
  projectCatalogErrorByScope: { local: null as string | null, remote: null as string | null },
  projectCatalogRetryHeadByScope: { local: false, remote: false },
}));
vi.mock("../../stores/main", () => ({
  useStore: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock("./Sidebar.autoAnimate", () => ({ useSidebarAutoAnimateRef: () => undefined }));
vi.mock("../../routes/-__root.bounded-bootstrap", () => ({
  loadAllProjectCatalog: vi.fn(),
  loadMoreProjectCatalog: vi.fn(),
}));
vi.mock("./SidebarProjectItem", () => ({ SortableProjectItem: () => null }));

import { SidebarProjectList } from "./SidebarProjectList";

function render(scope: "local" | "remote") {
  return renderToStaticMarkup(
    <SidebarProjectList
      renderedProjects={[]}
      isManualSorting={false}
      hasProjects={false}
      showEmptyState
      showLoadMore
      catalogScope={scope}
      onDragStart={vi.fn()}
      onDragEnd={vi.fn()}
      onDragCancel={vi.fn()}
      renderProjectItem={() => null}
    />,
  );
}

describe("sidebar catalog wording", () => {
  it("keeps local project copy while using workspace copy for remote pagination and empty state", () => {
    const local = render("local");
    expect(local).toContain("Load 5 more projects");
    expect(local).toContain("Load all 7 projects");
    expect(local).toContain("No projects yet");
    const remote = render("remote");
    expect(remote).toContain("Load 5 more workspaces");
    expect(remote).toContain("Load all 7 workspaces");
    expect(remote).toContain("No workspaces yet");
    expect(remote).not.toContain("projects");
  });

  it("uses workspace wording for singular, loading, and retry states", () => {
    state.projectCatalogRemainingCountByScope.remote = 1;
    expect(render("remote")).toContain("Load 1 more workspace");
    state.projectCatalogLoadingByScope.remote = true;
    expect(render("remote")).toContain("Loading workspaces...");
    state.projectCatalogLoadingByScope.remote = false;
    state.projectCatalogErrorByScope.remote = "unavailable";
    expect(render("remote")).toContain("Retry loading workspaces");
    state.projectCatalogErrorByScope.remote = null;
    state.projectCatalogRemainingCountByScope.remote = 7;
  });
});
