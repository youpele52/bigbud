import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { useSidebarProjectMetadata } from "./Sidebar.state.projectMetadata";
import { useSidebarProjectGitStatus } from "./Sidebar.state.gitStatus";
import { resolveRemoteThreadActivation } from "./Sidebar.remoteThreadActivation";
import { useStore } from "../../stores/main";
import { runBoundedBootstrap } from "../../routes/-__root.bounded-bootstrap";
import {
  createProjectGateApi,
  otherId,
  otherProjectId,
  resetProjectGateStore,
} from "../chat/view/ThreadProjectGate.test-helpers";

const mocks = vi.hoisted(() => ({ gitTargets: vi.fn() }));
vi.mock("../../hooks/useSidebarGitStatus", () => ({
  useSidebarGitStatus: (targets: unknown) => {
    mocks.gitTargets(targets);
    return {};
  },
}));

function MetadataHarness() {
  const { projects, metadataProjects, projectCwdById } = useSidebarProjectMetadata();
  const threads = useStore((store) => store.sidebarThreadsById);
  useSidebarProjectGitStatus(metadataProjects, Object.values(threads), projectCwdById);
  const activation = resolveRemoteThreadActivation(threads[otherId], projectCwdById);
  return (
    <>
      <span data-testid="catalog">{projects.map((project) => project.id).join(",")}</span>
      <span data-testid="cwd">{activation?.cwd}</span>
    </>
  );
}

beforeEach(() => {
  resetProjectGateStore();
  mocks.gitTargets.mockClear();
});
afterEach(async () => {
  await cleanup();
});

it("hides dependency-only projects without losing Recent/pinned git and activation metadata", async () => {
  const { api } = createProjectGateApi();
  await runBoundedBootstrap({ api, selectedThreadId: otherId, disposed: () => false });
  const target = "ssh:host=devbox&user=root&port=22&auth=ssh-key";
  const state = useStore.getState();
  const thread = state.sidebarThreadsById[otherId]!;
  useStore.setState({
    projects: state.projects.map((project) =>
      project.id === otherProjectId
        ? { ...project, cwd: "/srv/dependency", workspaceExecutionTargetId: target }
        : project,
    ),
    projectDependencyOnlyIds: { [otherProjectId]: true },
    sidebarPinnedThreadIds: [otherId],
    sidebarRecentThreadIds: [otherId],
    sidebarThreadsById: {
      ...state.sidebarThreadsById,
      [otherId]: { ...thread, workspaceExecutionTargetId: target, worktreePath: null },
    },
  });
  const screen = await render(<MetadataHarness />);
  await expect.element(screen.getByTestId("catalog")).not.toHaveTextContent(otherProjectId);
  await expect.element(screen.getByTestId("cwd")).toHaveTextContent("/srv/dependency");
  expect(mocks.gitTargets).toHaveBeenLastCalledWith(
    expect.arrayContaining([
      expect.objectContaining({
        threadId: otherId,
        cwd: "/srv/dependency",
        executionTargetId: target,
      }),
    ]),
  );
  useStore.setState({
    projects: useStore
      .getState()
      .projects.map((project) =>
        project.id === otherProjectId
          ? Object.assign({}, project, { cwd: "/srv/reconnected" })
          : project,
      ),
  });
  await expect.element(screen.getByTestId("cwd")).toHaveTextContent("/srv/reconnected");
  const legacyThread = { ...useStore.getState().sidebarThreadsById[otherId]! };
  delete legacyThread.workspaceExecutionTargetId;
  delete legacyThread.executionTargetId;
  useStore.setState({ sidebarThreadsById: { [otherId]: legacyThread } });
  await vi.waitFor(() =>
    expect(mocks.gitTargets).toHaveBeenLastCalledWith([
      expect.objectContaining({
        threadId: otherId,
        cwd: "/srv/reconnected",
        executionTargetId: target,
      }),
    ]),
  );
});
