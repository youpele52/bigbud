import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import type { ProjectSummary } from "@bigbud/contracts/orchestration/orchestration.catalog";

const { Wrapper } = vi.hoisted(() => ({
  Wrapper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/command", () => ({
  CommandGroup: Wrapper,
  CommandGroupLabel: Wrapper,
  CommandItem: Wrapper,
}));

import { ProjectSearchResultGroup, toProjectSearchResults } from "./SearchPalette.projectResults";

it("labels mixed search results as projects and remote workspaces with distinct fallbacks", () => {
  const local = {
    id: "local",
    title: "app",
    workspaceRoot: null,
    deletingAt: null,
  } as unknown as ProjectSummary;
  const remote = { ...local, id: "remote", title: "dev-vps" } as ProjectSummary;
  const results = toProjectSearchResults({ localProjects: [local], remoteWorkspaces: [remote] });
  const html = renderToStaticMarkup(
    <ProjectSearchResultGroup
      query=""
      results={results}
      visibleResults={results}
      onSelect={vi.fn()}
      onShowMore={vi.fn()}
    />,
  );
  expect(html).toContain("Projects and remote workspaces");
  expect(html).toContain("Local project");
  expect(html).toContain("Remote workspace");
  expect(html).not.toContain("Remote project");
});
