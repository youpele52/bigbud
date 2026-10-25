import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import type { RemoteProjectConnectionSource } from "./Sidebar.projects.logic";

const REMOTE_PROJECT_CONNECTION_SOURCE_KEY = "remote_project_connection_source";
const RemoteProjectConnectionSourceSchema = Schema.Literals(["manual", "ssh-config"]);

/** The source the user last chose in the add dialog; "From SSH config" until they pick one. */
export function readLastRemoteProjectConnectionSource(): RemoteProjectConnectionSource {
  try {
    return (
      getLocalStorageItem(
        REMOTE_PROJECT_CONNECTION_SOURCE_KEY,
        RemoteProjectConnectionSourceSchema,
      ) ?? "ssh-config"
    );
  } catch {
    return "ssh-config";
  }
}

export function rememberRemoteProjectConnectionSource(source: RemoteProjectConnectionSource): void {
  try {
    setLocalStorageItem(
      REMOTE_PROJECT_CONNECTION_SOURCE_KEY,
      source,
      RemoteProjectConnectionSourceSchema,
    );
  } catch {
    // A full or unavailable storage only loses the preference.
  }
}
