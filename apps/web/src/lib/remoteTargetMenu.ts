import { isSshExecutionTargetId } from "../components/sidebar/Sidebar.remoteWorkspaces.logic";

export type RemoteTargetMenuActionId = "reconnect" | "disconnect" | "connect";

export interface RemoteTargetMenuItem {
  readonly id: RemoteTargetMenuActionId;
  readonly label: string;
  readonly disabled?: boolean;
}

const REMOTE_TARGET_MENU_ACTION_IDS: ReadonlySet<string> = new Set<RemoteTargetMenuActionId>([
  "reconnect",
  "disconnect",
  "connect",
]);

export function isRemoteTargetMenuActionId(id: unknown): id is RemoteTargetMenuActionId {
  return typeof id === "string" && REMOTE_TARGET_MENU_ACTION_IDS.has(id);
}

/**
 * The connection controls every remote-workspace menu shows (workspace menu, thread menu,
 * composer picker): Reconnect then Disconnect, or Connect alone once the user disconnected.
 * Restart needs a connection, so Reconnect hides while disconnected. Empty for non-SSH targets.
 */
export function buildRemoteTargetMenuItems(input: {
  readonly executionTargetId: string | null | undefined;
  readonly disconnected: boolean;
  readonly reconnectPending: boolean;
}): RemoteTargetMenuItem[] {
  if (!input.executionTargetId || !isSshExecutionTargetId(input.executionTargetId)) return [];
  if (input.disconnected) return [{ id: "connect", label: "Connect" }];
  return [
    { id: "reconnect", label: "Reconnect", disabled: input.reconnectPending },
    { id: "disconnect", label: "Disconnect" },
  ];
}
