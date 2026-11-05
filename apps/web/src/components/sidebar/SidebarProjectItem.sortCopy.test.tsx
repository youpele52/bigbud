import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { Wrapper } = vi.hoisted(() => ({
  Wrapper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../ui/menu", () => {
  return {
    Menu: Wrapper,
    MenuGroup: Wrapper,
    MenuPopup: Wrapper,
    MenuRadioGroup: Wrapper,
    MenuRadioItem: Wrapper,
    MenuTrigger: Wrapper,
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: Wrapper,
  TooltipPopup: Wrapper,
  TooltipTrigger: Wrapper,
}));

import { ProjectSortMenu } from "./SidebarProjectItem";

describe("sidebar sort menu wording", () => {
  it("preserves project sorting by default and names workspaces in remote scope", () => {
    const props = {
      projectSortOrder: "manual" as const,
      threadSortOrder: "updated_at" as const,
      onProjectSortOrderChange: vi.fn(),
      onThreadSortOrderChange: vi.fn(),
    };
    const local = renderToStaticMarkup(<ProjectSortMenu {...props} />);
    expect(local.match(/Sort projects/g)).toHaveLength(2);
    const remote = renderToStaticMarkup(<ProjectSortMenu {...props} scope="remote" />);
    expect(remote.match(/Sort workspaces/g)).toHaveLength(2);
    expect(remote).not.toContain("Sort projects");
    expect(remote).toContain("Sort threads");
  });
});
