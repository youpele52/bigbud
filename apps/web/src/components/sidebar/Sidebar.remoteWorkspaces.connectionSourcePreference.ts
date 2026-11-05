import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import type { RemoteWorkspaceConnectionSource } from "./Sidebar.remoteWorkspaces.logic";

// Retain the existing key so the terminology change preserves the chosen connection source.
const REMOTE_WORKSPACE_CONNECTION_SOURCE_KEY = "remote_project_connection_source";
const RemoteWorkspaceConnectionSourceSchema = Schema.Literals(["manual", "ssh-config"]);

/** The source the user last chose in the add dialog; "From SSH config" until they pick one. */
export function readLastRemoteWorkspaceConnectionSource(): RemoteWorkspaceConnectionSource {
  try {
    return (
      getLocalStorageItem(
        REMOTE_WORKSPACE_CONNECTION_SOURCE_KEY,
        RemoteWorkspaceConnectionSourceSchema,
      ) ?? "ssh-config"
    );
  } catch {
    return "ssh-config";
  }
}

export function rememberRemoteWorkspaceConnectionSource(
  source: RemoteWorkspaceConnectionSource,
): void {
  try {
    setLocalStorageItem(
      REMOTE_WORKSPACE_CONNECTION_SOURCE_KEY,
      source,
      RemoteWorkspaceConnectionSourceSchema,
    );
  } catch {
    // A full or unavailable storage only loses the preference.
  }
}
