import "../../index.css";

import { ProjectId } from "@bigbud/contracts";
import { vi } from "vitest";
import { render } from "vitest-browser-react";

const nativeApi = vi.hoisted(() => ({ current: null as never }));

vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => nativeApi.current }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useParams: () => null }));
vi.mock("../../stores/main", () => ({ useStore: () => ({ threads: [] }) }));
vi.mock("../../stores/ui", () => ({
  useUiStateStore: (selector: (state: Record<string, () => void>) => unknown) =>
    selector({
      reorderProjects: vi.fn(),
      setProjectExpanded: vi.fn(),
      setSelectedProject: vi.fn(),
      toggleProject: vi.fn(),
    }),
}));
vi.mock("../../stores/remoteAccess/remoteAccess.store", () => ({
  useRemoteAccessStore: Object.assign(() => new Set(), {
    getState: () => ({ recordRemoteConnection: vi.fn() }),
  }),
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
import { SidebarRemoteAgentInstallDialog } from "./SidebarRemoteAgentInstallDialog";
import type { CreateProjectInput, CreateProjectResult } from "./Sidebar.projectAddActions.helpers";

export type CreateProject = (input: CreateProjectInput) => Promise<CreateProjectResult>;

export const project = {
  id: ProjectId.makeUnsafe("project-1"),
  name: "Remote project",
  providerRuntimeExecutionTargetId: "local",
  workspaceExecutionTargetId: "ssh:host=old-host&user=alice&port=2222&auth=ssh-key",
  cwd: "/srv/project",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function RemoteProjectEditHarness({
  createProject = vi.fn<CreateProject>().mockResolvedValue({ ok: true }),
}: {
  createProject?: CreateProject;
}) {
  const remote = useSidebarRemoteProjectAddActions({ createProject, isAddingProject: false });
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
      <button type="button" onClick={remote.openRemoteProjectDialog}>
        Open add dialog
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
        onSubmit={() => void remote.submitRemoteProjectDialog()}
      />
      <SidebarRemoteAgentInstallDialog
        request={remote.remoteAgentInstallRequest}
        onDecline={remote.declineRemoteAgentInstall}
        onInstalled={remote.completeRemoteAgentInstall}
      />
    </>
  );
}

export async function mountHarness(createProject?: CreateProject) {
  const host = document.createElement("div");
  document.body.append(host);
  const props = createProject === undefined ? {} : { createProject };
  const screen = await render(<RemoteProjectEditHarness {...props} />, { container: host });
  return {
    [Symbol.asyncDispose]: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

export function setApi(input: {
  readonly verifyExecutionTarget: ReturnType<typeof vi.fn>;
  readonly installRemoteAgent?: ReturnType<typeof vi.fn>;
  readonly connectRemoteAgent?: ReturnType<typeof vi.fn>;
  readonly getSnapshot: ReturnType<typeof vi.fn>;
  readonly dispatchCommand: ReturnType<typeof vi.fn>;
  readonly show: ReturnType<typeof vi.fn>;
}) {
  nativeApi.current = {
    contextMenu: { show: input.show },
    server: {
      verifyExecutionTarget: input.verifyExecutionTarget,
      installRemoteAgent: input.installRemoteAgent ?? vi.fn(),
      connectRemoteAgent: input.connectRemoteAgent ?? vi.fn(),
    },
    orchestration: { getSnapshot: input.getSnapshot, dispatchCommand: input.dispatchCommand },
  } as never;
}

export function resetApi() {
  document.body.innerHTML = "";
  nativeApi.current = null as never;
}
