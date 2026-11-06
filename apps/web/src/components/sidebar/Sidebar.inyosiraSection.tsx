import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { InyosiraStatus } from "./Sidebar.inyosiraStatus";
import { useMemo } from "react";

import { useStore } from "../../stores/main";
import { useInyosiraCatalog } from "./Sidebar.inyosira.catalog";
import { INYOSIRA_BOTTOM_STATES, groupInyosiraThreadIds } from "./Sidebar.inyosira.logic";
import { SidebarInyosiraGroup } from "./Sidebar.inyosiraGroup";
import type { SharedProjectItemProps } from "./Sidebar.types";

/** Attention first, then current work; Later and Done remain below. */
export function SidebarInyosiraSection({ shared }: { shared: SharedProjectItemProps }) {
  const summaries = useStore((store) => store.sidebarThreadsById);
  const projects = useStore((store) => store.projects);
  const { pages, loadMore } = useInyosiraCatalog(true);
  const groups = useMemo(() => groupInyosiraThreadIds(summaries), [summaries]);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const renderGroup = (state: ThreadOrganizationState) => (
    <SidebarInyosiraGroup
      key={state}
      state={state}
      threadIds={groups[state]}
      summaries={summaries}
      projectById={projectById}
      page={pages[state]}
      loadMore={loadMore}
      shared={shared}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col pb-2" data-testid="inyosira-section">
      <InyosiraStatus />
      {renderGroup("needs-you")}
      {renderGroup("present")}
      <div className="mt-auto flex flex-col gap-1 pt-4">
        {INYOSIRA_BOTTOM_STATES.map(renderGroup)}
      </div>
    </div>
  );
}
