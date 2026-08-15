import "../../index.css";

import { ProjectId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const nativeApi = vi.hoisted(() => ({ current: null as never }));

vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => nativeApi.current }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => null,
}));
vi.mock("../../stores/main", () => ({ useStore: () => ({ threads: [] }) }));
vi.mock("../../stores/ui", () => ({
  useUiStateStore: (
    selector: (state: {
      reorderProjects: () => void;
      setProjectExpanded: () => void;
      setSelectedProject: () => void;
      toggleProject: () => void;
    }) => unknown,
  ) =>
    selector({
      reorderProjects: vi.fn(),
      setProjectExpanded: vi.fn(),
      setSelectedProject: vi.fn(),
      toggleProject: vi.fn(),
    }),
}));
vi.mock("../../stores/remoteAccess/remoteAccess.store", () => ({
  useRemoteAccessStore: () => new Set(),
}));
vi.mock("../../hooks/useRemoteExecutionAccessGate", () => ({
  useRemoteExecutionAccessGate: () => ({ beginRemoteExecutionTargetAccessCheck: vi.fn() }),
}));
vi.mock("./Sidebar.projectActions.rename", () => ({
  useSidebarProjectRenameActions: () => ({
    renamingProjectId: null,
    setRenamingProjectId: vi.fn(),
    renamingProjectTitle: "",
    setRenamingProjectTitle: vi.fn(),
    projectRenamingCommittedRef: { current: false },
    cancelProjectRename: vi.fn(),
    onProjectRenamingInputMount: vi.fn(),
    hasProjectRenameCommitted: () => false,
    markProjectRenameCommitted: vi.fn(),
    commitProjectRename: vi.fn(),
  }),
}));

import { useRef } from "react";

import { useSidebarProjectActions } from "./Sidebar.projectActions";
import { useSidebarRemoteProjectAddActions } from "./Sidebar.projectAddActions.remote";
import { SidebarRemoteProjectDialog } from "./SidebarRemoteProjectDialog";

const project = {
  id: ProjectId.makeUnsafe("project-1"),
  name: "Remote project",
  providerRuntimeExecutionTargetId: "local",
  workspaceExecutionTargetId: "ssh:host=old-host&user=alice&port=2222&auth=ssh-key",
  cwd: "/srv/project",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function RemoteProjectEditHarness() {
  const remote = useSidebarRemoteProjectAddActions({
    createProject: vi.fn(),
    isAddingProject: false,
  });
  const projectActions = useSidebarProjectActions({
    projects: [project] as never,
    threadIdsByProjectId: {},
    sidebarProjects: [],
    appSettings: { sidebarProjectSortOrder: "manual" } as never,
    dragInProgressRef: useRef(false),
    suppressProjectClickAfterDragRef: useRef(false),
    suppressProjectClickForContextMenuRef: useRef(false),
    selectedThreadIdsSize: 0,
    clearSelection: vi.fn(),
    copyPathToClipboard: vi.fn(),
    cancelThreadRename: vi.fn(),
    openRemoteProjectEditDialog: remote.openRemoteProjectEditDialog,
  });

  return (
    <>
      <button
        type="button"
        onClick={() => projectActions.handleProjectContextMenu(project.id, { x: 1, y: 1 })}
      >
        Open project menu
      </button>
      <SidebarRemoteProjectDialog
        mode={remote.remoteProjectDialogMode}
        open={remote.isRemoteProjectDialogOpen}
        draft={remote.remoteProjectDraft}
        fieldErrors={remote.remoteProjectFieldErrors}
        error={remote.remoteProjectError}
        verificationMessage={remote.remoteProjectVerificationMessage}
        isSubmitting={remote.isSavingRemoteProject}
        isVerifying={remote.isVerifyingRemoteProject}
        onOpenChange={(open) => {
          if (!open) remote.closeRemoteProjectDialog();
        }}
        onFieldChange={remote.updateRemoteProjectDraft}
        onSubmit={() => {
          void remote.submitRemoteProjectDialog();
        }}
      />
    </>
  );
}

async function mountHarness() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<RemoteProjectEditHarness />, { container: host });
  return {
    [Symbol.asyncDispose]: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function setApi(input: {
  readonly verifyExecutionTarget: ReturnType<typeof vi.fn>;
  readonly getSnapshot: ReturnType<typeof vi.fn>;
  readonly dispatchCommand: ReturnType<typeof vi.fn>;
  readonly show: ReturnType<typeof vi.fn>;
}) {
  nativeApi.current = {
    contextMenu: { show: input.show },
    server: { verifyExecutionTarget: input.verifyExecutionTarget },
    orchestration: {
      getSnapshot: input.getSnapshot,
      dispatchCommand: input.dispatchCommand,
    },
  } as never;
}

describe("SidebarRemoteProjectDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    nativeApi.current = null as never;
  });

  it("opens a prefilled edit dialog from the SSH project context menu", async () => {
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn(),
      getSnapshot: vi.fn(),
      dispatchCommand: vi.fn(),
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open project menu" }).click();

    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    await expect.element(page.getByText("Edit SSH remote project")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Host or IP")).toHaveValue("old-host");
    await expect.element(page.getByLabelText("Username")).toHaveValue("alice");
    await expect.element(page.getByLabelText("Port")).toHaveValue("2222");
    await expect.element(page.getByLabelText("Remote project path")).toHaveValue("/srv/project");
  });

  it("disables Save while the edit submission is pending", async () => {
    let resolveDispatch: (() => void) | undefined;
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue({ message: "verified" }),
      getSnapshot: vi.fn().mockResolvedValue({ projects: [], threads: [] }),
      dispatchCommand: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDispatch = resolve;
          }),
      ),
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect.element(page.getByRole("button", { name: "Saving..." })).toBeDisabled();
    resolveDispatch?.();
  });

  it("keeps the dialog open when a retained worktree fails verification", async () => {
    const dispatchCommand = vi.fn();
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi
        .fn()
        .mockResolvedValueOnce({ message: "project verified" })
        .mockRejectedValueOnce(new Error("missing worktree")),
      getSnapshot: vi.fn().mockResolvedValue({
        projects: [],
        threads: [{ projectId: project.id, worktreePath: "/srv/worktree-a", deletedAt: null }],
      }),
      dispatchCommand,
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    await expect
      .element(page.getByText(/The new SSH target cannot access these worktrees/))
      .toBeInTheDocument();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });
});
