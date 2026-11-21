/** Menu glue shared by the workspace menu, thread menu and composer picker. */
import type { ProjectId } from "@bigbud/contracts";

import {
  buildRemoteTargetMenuItems,
  isRemoteTargetMenuActionId,
  type RemoteTargetMenuItem,
} from "../../lib/remoteTargetMenu";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import type { Project } from "../../models/types";
import { isExecutionTargetDisconnected, useRemoteAccessStore } from "./remoteAccess.store";
import { requestConnect, requestDisconnect } from "./remoteTargetActions.connection";
import { requestReconnect } from "./remoteTargetActions.reconnect";
import { isReconnectPending, useIsReconnectPending } from "./remoteTargetActions.store";

/** Current remote items for a project's workspace target (read live at menu-open time). */
export function readRemoteTargetMenuItems(
  project: Pick<Project, "id" | "workspaceExecutionTargetId" | "executionTargetId">,
): RemoteTargetMenuItem[] {
  const executionTargetId = resolveWorkspaceExecutionTargetId(project);
  return buildRemoteTargetMenuItems({
    executionTargetId,
    disconnected: isExecutionTargetDisconnected(executionTargetId),
    reconnectPending: isReconnectPending(project.id),
  });
}

/** Reactive variant for menus rendered by React (composer picker). */
export function useRemoteTargetMenuItems(
  project: Pick<Project, "id" | "workspaceExecutionTargetId" | "executionTargetId">,
): RemoteTargetMenuItem[] {
  const executionTargetId = resolveWorkspaceExecutionTargetId(project);
  const disconnected = useRemoteAccessStore(
    (state) => state.disconnectedExecutionTargetIds[executionTargetId] === true,
  );
  const reconnectPending = useIsReconnectPending(project.id);
  return buildRemoteTargetMenuItems({ executionTargetId, disconnected, reconnectPending });
}

/** Runs a clicked remote item for the project; `false` when the id is not a remote item. */
export async function runRemoteTargetMenuAction(
  clicked: string | null | undefined,
  projectId: ProjectId,
): Promise<boolean> {
  if (!isRemoteTargetMenuActionId(clicked)) return false;
  if (clicked === "reconnect") requestReconnect(projectId);
  else if (clicked === "disconnect") requestDisconnect(projectId);
  else await requestConnect(projectId);
  return true;
}
