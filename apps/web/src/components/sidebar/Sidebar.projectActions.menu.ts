import { isElectron } from "../../config/env";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { buildRemoteTargetMenuItems } from "../../lib/remoteTargetMenu";
import type { Project } from "../../models/types";
import {
  isRemoteExecutionTargetId,
  isSshExecutionTargetId,
} from "./Sidebar.remoteWorkspaces.logic";

export function buildProjectContextMenuItems(input: {
  readonly project: Project;
  readonly reconnectDisabled: boolean;
  /** The user disconnected this SSH target; restart needs a connection, so Reconnect hides. */
  readonly disconnected: boolean;
}) {
  const target = resolveWorkspaceExecutionTargetId(input.project);
  const isSshWorkspace = isSshExecutionTargetId(target);
  const isRemoteWorkspace = isRemoteExecutionTargetId(target);
  return [
    { id: "rename", label: isRemoteWorkspace ? "Rename remote workspace" : "Rename project" },
    ...(isSshWorkspace ? [{ id: "edit-ssh", label: "Edit remote workspace" }] : []),
    ...(!isRemoteWorkspace ? [{ id: "edit-local", label: "Edit project" }] : []),
    ...(isElectron && !isRemoteWorkspace && input.project.cwd
      ? [{ id: "reveal-folder", label: "Reveal project folder" }]
      : []),
    ...(input.project.cwd
      ? [
          {
            id: "copy-path",
            label: isRemoteWorkspace ? "Copy Workspace Path" : "Copy Project Path",
          },
        ]
      : []),
    // Connection controls sit together directly above Remove (shared with the thread menu).
    ...buildRemoteTargetMenuItems({
      executionTargetId: target,
      disconnected: input.disconnected,
      reconnectPending: input.reconnectDisabled,
    }),
    {
      id: "delete",
      label: isRemoteWorkspace ? "Remove remote workspace" : "Remove project",
      destructive: true,
    },
  ];
}
