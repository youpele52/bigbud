import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import type { Project } from "../../models/types";
import {
  isRemoteExecutionTargetId,
  isSshExecutionTargetId,
} from "./Sidebar.remoteWorkspaces.logic";

export function buildProjectContextMenuItems(input: {
  readonly project: Project;
  readonly reconnectDisabled: boolean;
}) {
  const target = resolveWorkspaceExecutionTargetId(input.project);
  const isSshWorkspace = isSshExecutionTargetId(target);
  const isRemoteWorkspace = isRemoteExecutionTargetId(target);
  return [
    ...(isSshWorkspace
      ? [{ id: "reconnect", label: "Reconnect", disabled: input.reconnectDisabled }]
      : []),
    { id: "rename", label: isRemoteWorkspace ? "Rename remote workspace" : "Rename project" },
    ...(isSshWorkspace ? [{ id: "edit-ssh", label: "Edit remote workspace" }] : []),
    ...(input.project.cwd
      ? [
          {
            id: "copy-path",
            label: isRemoteWorkspace ? "Copy Workspace Path" : "Copy Project Path",
          },
        ]
      : []),
    {
      id: "delete",
      label: isRemoteWorkspace ? "Remove remote workspace" : "Remove project",
      destructive: true,
    },
  ];
}
