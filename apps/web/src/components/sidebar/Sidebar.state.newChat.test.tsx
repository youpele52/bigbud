import { BUILT_IN_CHATS_PROJECT_ID, ProjectId } from "@bigbud/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { useHandleNewThread } from "../../hooks/useHandleNewThread";

const selected = vi.hoisted(() => ({
  projectId: null as ReturnType<typeof ProjectId.makeUnsafe> | null,
}));

vi.mock("../../stores/ui", () => ({
  useUiStateStore: (
    selector: (state: { selectedProjectId: typeof selected.projectId }) => unknown,
  ) => selector({ selectedProjectId: selected.projectId }),
}));

import { useSidebarNewChatActions } from "./Sidebar.state.newChat";

const projectId = ProjectId.makeUnsafe("sidebar-project");

function renderActions(activeThread?: ReturnType<typeof useHandleNewThread>["activeThread"]) {
  const handleNewThread = vi.fn(async () => {});
  const result: { actions?: ReturnType<typeof useSidebarNewChatActions> } = {};
  function SidebarActionsHarness() {
    result.actions = useSidebarNewChatActions({
      activeThread,
      activeDraftThread: null,
      chatsProjectId: BUILT_IN_CHATS_PROJECT_ID,
      handleNewThread,
    });
    return null;
  }
  renderToStaticMarkup(<SidebarActionsHarness />);
  if (!result.actions) throw new Error("Sidebar actions did not render");
  return { actions: result.actions, handleNewThread };
}

describe("sidebar new chat actions", () => {
  it("uses active worktree context for the main action and Chats for the section action", async () => {
    selected.projectId = null;
    const { actions, handleNewThread } = renderActions({
      projectId,
      branch: "feature",
      worktreePath: "/repo/worktree",
    } as ReturnType<typeof useHandleNewThread>["activeThread"]);

    await actions.handleNewChat();
    await actions.handleNewChats();

    expect(handleNewThread).toHaveBeenNthCalledWith(1, projectId, {
      branch: "feature",
      worktreePath: "/repo/worktree",
      envMode: "worktree",
    });
    expect(handleNewThread).toHaveBeenNthCalledWith(2, BUILT_IN_CHATS_PROJECT_ID, {
      branch: null,
      worktreePath: null,
      envMode: "local",
    });
  });

  it("uses selected project when no thread is active, then Chats when none is selected", async () => {
    selected.projectId = projectId;
    const projectActions = renderActions();
    await projectActions.actions.handleNewChat();
    expect(projectActions.handleNewThread).toHaveBeenCalledWith(projectId, {
      branch: null,
      worktreePath: null,
      envMode: "local",
    });

    selected.projectId = null;
    const chatsActions = renderActions();
    await chatsActions.actions.handleNewChat();
    expect(chatsActions.handleNewThread).toHaveBeenCalledWith(BUILT_IN_CHATS_PROJECT_ID, {
      branch: null,
      worktreePath: null,
      envMode: "local",
    });
  });
});
