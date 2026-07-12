import "../../index.css";

import { ProjectId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useStore } from "../../stores/main";
import type { Project } from "../../models/types";

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: vi.fn() }),
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({ sidebarThreadSortOrder: "updated" }),
}));

import BranchToolbarProjectMenu from "./BranchToolbarProjectMenu";

const activeProject = {
  id: ProjectId.makeUnsafe("project-side-chat-selector"),
  name: "Selector project",
} as Project;

describe("BranchToolbarProjectMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useStore.setState({ projects: [], threads: [] });
  });

  it("mounts with a stable standard-thread store snapshot", async () => {
    useStore.setState({ projects: [activeProject], threads: [] });

    await render(<BranchToolbarProjectMenu activeProject={activeProject} />);

    await expect.element(page.getByText("Selector project")).toBeInTheDocument();
  });
});
