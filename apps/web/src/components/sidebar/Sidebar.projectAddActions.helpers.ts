import type { ProviderRuntimeLocation } from "../../lib/providerExecutionTargets";
import type { RemoteWorkspaceDraft } from "./Sidebar.remoteWorkspaces.logic";

export type RemoteWorkspaceField =
  | "displayName"
  | "host"
  | "username"
  | "port"
  | "workspaceRoot"
  | "sshKeyPath";

export interface CreateProjectInput {
  readonly rawCwd: string;
  readonly title: string;
  readonly providerRuntimeLocation: ProviderRuntimeLocation;
  readonly workspaceExecutionTargetId: string;
}

export type CreateProjectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type RemoteWorkspaceFieldErrors = Partial<Record<RemoteWorkspaceField, string>>;

export function createRemoteWorkspaceFieldErrors(
  draft: RemoteWorkspaceDraft,
): RemoteWorkspaceFieldErrors {
  const errors: RemoteWorkspaceFieldErrors = {};
  if (draft.host.trim().length === 0) {
    errors.host =
      draft.connectionSource === "ssh-config"
        ? "Pick an SSH config host."
        : "Enter an SSH host, IP, or SSH config host.";
  }
  const port = draft.port.trim();
  if (port.length > 0) {
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
      errors.port = "Port must be a whole number between 1 and 65535.";
    }
  }
  if (draft.workspaceRoot.trim().length === 0) {
    errors.workspaceRoot = "Choose a folder or enter the remote workspace path.";
  }
  return errors;
}

export function hasRemoteWorkspaceFieldErrors(errors: RemoteWorkspaceFieldErrors): boolean {
  return Object.values(errors).some((value) => typeof value === "string" && value.length > 0);
}

const CONNECTION_ERROR_FIELDS: ReadonlyArray<RemoteWorkspaceField> = [
  "host",
  "username",
  "port",
  "sshKeyPath",
];

/**
 * Clears errors for an edited field, keeping the same object when there are none. Switching the
 * connection source swaps every connection field, so their errors no longer apply.
 */
export function withoutRemoteWorkspaceFieldError(
  errors: RemoteWorkspaceFieldErrors,
  field: string,
): RemoteWorkspaceFieldErrors {
  const cleared =
    field === "connectionSource" ? CONNECTION_ERROR_FIELDS : [field as RemoteWorkspaceField];
  if (!cleared.some((key) => key in errors)) {
    return errors;
  }
  const next = { ...errors };
  for (const key of cleared) delete next[key];
  return next;
}
