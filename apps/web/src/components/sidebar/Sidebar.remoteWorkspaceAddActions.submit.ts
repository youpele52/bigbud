import { useCallback, type Dispatch, type SetStateAction } from "react";

import type { ProjectId } from "@bigbud/contracts";
import {
  createRemoteWorkspaceExecutionTargetId,
  deriveProjectTitleFromCwd,
  getRemoteWorkspaceConnectionLabel,
  type RemoteWorkspaceDraft,
} from "./Sidebar.remoteWorkspaces.logic";
import { reconfigureRemoteWorkspace } from "./Sidebar.remoteWorkspaceAddActions.edit";
import type { CreateProjectInput, CreateProjectResult } from "./Sidebar.projectAddActions.helpers";

interface UseRemoteWorkspaceSubmitInput {
  readonly createProject: (input: CreateProjectInput) => Promise<CreateProjectResult>;
  readonly dialogMode: "add" | "edit";
  readonly editingProjectId: ProjectId | null;
  readonly editingProjectUpdatedAt: string | null;
  readonly resetDialog: () => void;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly setSaving: Dispatch<SetStateAction<boolean>>;
}

export function useRemoteWorkspaceSubmit(input: UseRemoteWorkspaceSubmitInput) {
  return useCallback(
    async (candidate: RemoteWorkspaceDraft) => {
      const remoteTargetLabel = getRemoteWorkspaceConnectionLabel(candidate);
      const title =
        candidate.displayName.trim().length > 0
          ? candidate.displayName.trim()
          : `${deriveProjectTitleFromCwd(candidate.workspaceRoot)} (${remoteTargetLabel})`;

      if (input.dialogMode === "edit") {
        if (!input.editingProjectId || !input.editingProjectUpdatedAt) {
          input.setError(
            "Remote workspace revision is unavailable. Close and reopen the SSH configuration.",
          );
          return;
        }
        input.setSaving(true);
        try {
          const error = await reconfigureRemoteWorkspace({
            projectId: input.editingProjectId,
            title,
            draft: candidate,
            expectedUpdatedAt: input.editingProjectUpdatedAt,
          });
          if (!error) input.resetDialog();
          else input.setError(error);
        } finally {
          input.setSaving(false);
        }
        return;
      }

      const result = await input.createProject({
        rawCwd: candidate.workspaceRoot,
        providerRuntimeLocation: candidate.providerRuntimeLocation,
        workspaceExecutionTargetId: createRemoteWorkspaceExecutionTargetId(candidate),
        title,
      });
      if (!result.ok) {
        input.setError(result.error);
        return;
      }
      input.resetDialog();
    },
    [input],
  );
}
