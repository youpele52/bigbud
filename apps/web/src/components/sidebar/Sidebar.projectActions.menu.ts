import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import type { Project } from "../../models/types";
import { isSshExecutionTargetId } from "./Sidebar.projects.logic";

export function buildProjectContextMenuItems(input: {
  readonly project: Project;
  readonly reconnectDisabled: boolean;
}) {
  const isSshProject = isSshExecutionTargetId(resolveWorkspaceExecutionTargetId(input.project));
  return [
    ...(isSshProject
      ? ([
          {
            id: "reconnect",
            label: "Reconnect",
            disabled: input.reconnectDisabled,
          },
        ] as const)
      : []),
    { id: "rename", label: "Rename project" },
    ...(isSshProject ? ([{ id: "edit-ssh", label: "Edit SSH configuration" }] as const) : []),
    ...(input.project.cwd ? ([{ id: "copy-path", label: "Copy Project Path" }] as const) : []),
    { id: "delete", label: "Remove project", destructive: true },
  ];
}
