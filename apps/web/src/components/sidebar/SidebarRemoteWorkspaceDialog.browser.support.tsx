import "../../index.css";

import { ProjectId } from "@bigbud/contracts";
import { vi } from "vitest";
import { render } from "vitest-browser-react";

const nativeApi = vi.hoisted(() => ({ current: null as never }));

vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => nativeApi.current,
  ensureNativeApi: () => nativeApi.current,
}));
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
    getState: () => ({ recordRemoteConnection: vi.fn(), remoteConnections: {} }),
  }),
  useIsExecutionTargetDisconnected: () => false,
  useDisconnectedTargetsLoaded: () => true,
  areDisconnectedTargetsLoaded: () => true,
  isExecutionTargetDisconnected: () => false,
  isExecutionTargetVerified: () => false,
  REMOTE_EXECUTION_TARGET_DISCONNECTED_MESSAGE:
    "Remote workspace is disconnected. Connect it to continue.",
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
import { useSidebarRemoteWorkspaceAddActions } from "./Sidebar.remoteWorkspaceAddActions";
import { SidebarRemoteWorkspaceDialog } from "./SidebarRemoteWorkspaceDialog";
import { SidebarRemoteAgentInstallDialog } from "./SidebarRemoteAgentInstallDialog";
import { SidebarUnlockSshKeyDialog } from "./SidebarUnlockSshKeyDialog";
import type { CreateProjectInput, CreateProjectResult } from "./Sidebar.projectAddActions.helpers";

export type CreateProject = (input: CreateProjectInput) => Promise<CreateProjectResult>;

export const project = {
  id: ProjectId.makeUnsafe("project-1"),
  name: "Remote workspace",
  providerRuntimeExecutionTargetId: "local",
  workspaceExecutionTargetId: "ssh:host=old-host&user=alice&port=2222&auth=ssh-key",
  cwd: "/srv/project",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

export const directSshProject = {
  ...project,
  workspaceExecutionTargetId:
    "ssh:host=old-host&user=alice&port=2222&auth=ssh-key&transport=direct-ssh",
};

function RemoteWorkspaceEditHarness({
  createProject = vi.fn<CreateProject>().mockResolvedValue({ ok: true }),
  selectedProject = project,
}: {
  createProject?: CreateProject;
  selectedProject?: typeof project;
}) {
  const remote = useSidebarRemoteWorkspaceAddActions({ createProject, isAddingProject: false });
  const projectActions = useSidebarProjectActions({
    projects: [selectedProject] as never,
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
    openRemoteWorkspaceEditDialog: remote.openRemoteWorkspaceEditDialog,
  });
  return (
    <>
      <button
        type="button"
        onClick={() => projectActions.handleProjectContextMenu(selectedProject.id, { x: 1, y: 1 })}
      >
        Open project menu
      </button>
      <button type="button" onClick={remote.openRemoteWorkspaceDialog}>
        Open add dialog
      </button>
      <SidebarRemoteWorkspaceDialog
        mode={remote.remoteWorkspaceDialogMode}
        open={remote.isRemoteWorkspaceDialogOpen}
        draft={remote.remoteWorkspaceDraft}
        fieldErrors={remote.remoteWorkspaceFieldErrors}
        error={remote.remoteWorkspaceError}
        verificationMessage={remote.remoteWorkspaceVerificationMessage}
        isSubmitting={remote.isSavingRemoteWorkspace}
        isVerifying={remote.isVerifyingRemoteWorkspace}
        onOpenChange={(open) => {
          if (!open) remote.closeRemoteWorkspaceDialog();
        }}
        onFieldChange={remote.updateRemoteWorkspaceDraft}
        onAdoptConnectionSource={remote.adoptRemoteWorkspaceConnectionSource}
        onRequestUnlock={remote.requestRemoteWorkspaceUnlock}
        onSubmit={() => void remote.submitRemoteWorkspaceDialog()}
      />
      <SidebarRemoteAgentInstallDialog
        request={remote.remoteAgentInstallRequest}
        onDecline={remote.declineRemoteAgentInstall}
        onInstalled={remote.completeRemoteAgentInstall}
      />
      <SidebarUnlockSshKeyDialog
        open={remote.isRemoteWorkspaceUnlockDialogOpen}
        keyPath={remote.remoteWorkspaceUnlockKeyPath}
        title={
          remote.remoteWorkspaceUnlockMode === "password" ? "Enter SSH password" : "Unlock SSH key"
        }
        fieldLabel={
          remote.remoteWorkspaceUnlockMode === "password" ? "SSH password" : "Key passphrase"
        }
        submitLabel={
          remote.remoteWorkspaceUnlockMode === "password" ? "Continue" : "Unlock SSH key"
        }
        description={`Unlock ${remote.remoteWorkspaceUnlockKeyPath}`}
        secret={remote.remoteWorkspaceUnlockPassphrase}
        error={remote.remoteWorkspaceUnlockError}
        isSubmitting={remote.isUnlockingRemoteWorkspaceKey}
        onOpenChange={(open) => {
          if (!open) remote.closeRemoteWorkspaceUnlockDialog();
        }}
        onSecretChange={remote.setRemoteWorkspaceUnlockPassphrase}
        onSubmit={() => void remote.submitRemoteWorkspaceUnlock()}
      />
    </>
  );
}

export async function mountHarness(
  createProject?: CreateProject,
  selectedProject: typeof project = project,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const props = createProject === undefined ? {} : { createProject };
  const screen = await render(
    <RemoteWorkspaceEditHarness {...props} selectedProject={selectedProject} />,
    { container: host },
  );
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
  readonly listSshConfigHosts?: ReturnType<typeof vi.fn>;
  readonly listRemoteFolders?: ReturnType<typeof vi.fn>;
  readonly unlockSshKey?: ReturnType<typeof vi.fn>;
  readonly unlockSshPassword?: ReturnType<typeof vi.fn>;
  readonly trustSshHost?: ReturnType<typeof vi.fn>;
  readonly getProjectWorktreePaths: ReturnType<typeof vi.fn>;
  readonly dispatchCommand: ReturnType<typeof vi.fn>;
  readonly show: ReturnType<typeof vi.fn>;
}) {
  nativeApi.current = {
    contextMenu: { show: input.show },
    server: {
      verifyExecutionTarget: input.verifyExecutionTarget,
      installRemoteAgent: input.installRemoteAgent ?? vi.fn(),
      connectRemoteAgent: input.connectRemoteAgent ?? vi.fn(),
      ...(input.listSshConfigHosts ? { listSshConfigHosts: input.listSshConfigHosts } : {}),
      ...(input.listRemoteFolders ? { listRemoteFolders: input.listRemoteFolders } : {}),
      ...(input.unlockSshKey ? { unlockSshKey: input.unlockSshKey } : {}),
      ...(input.unlockSshPassword ? { unlockSshPassword: input.unlockSshPassword } : {}),
      ...(input.trustSshHost ? { trustSshHost: input.trustSshHost } : {}),
    },
    orchestration: {
      getProjectWorktreePaths: input.getProjectWorktreePaths,
      dispatchCommand: input.dispatchCommand,
    },
  } as never;
}

export function resetApi() {
  document.body.innerHTML = "";
  localStorage.removeItem("remote_project_connection_source");
  nativeApi.current = null as never;
}
