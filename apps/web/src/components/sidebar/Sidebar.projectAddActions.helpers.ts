import type { ProviderRuntimeLocation } from "../../lib/providerExecutionTargets";
import type { RemoteProjectDraft } from "./Sidebar.projects.logic";

export type RemoteProjectField =
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

export type RemoteProjectFieldErrors = Partial<Record<RemoteProjectField, string>>;

export function createRemoteProjectFieldErrors(
  draft: RemoteProjectDraft,
): RemoteProjectFieldErrors {
  const errors: RemoteProjectFieldErrors = {};
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
    errors.workspaceRoot = "Choose a folder or enter the remote project path.";
  }
  return errors;
}

export function hasRemoteProjectFieldErrors(errors: RemoteProjectFieldErrors): boolean {
  return Object.values(errors).some((value) => typeof value === "string" && value.length > 0);
}

const CONNECTION_ERROR_FIELDS: ReadonlyArray<RemoteProjectField> = [
  "host",
  "username",
  "port",
  "sshKeyPath",
];

/**
 * Clears errors for an edited field, keeping the same object when there are none. Switching the
 * connection source swaps every connection field, so their errors no longer apply.
 */
export function withoutRemoteProjectFieldError(
  errors: RemoteProjectFieldErrors,
  field: string,
): RemoteProjectFieldErrors {
  const cleared =
    field === "connectionSource" ? CONNECTION_ERROR_FIELDS : [field as RemoteProjectField];
  if (!cleared.some((key) => key in errors)) {
    return errors;
  }
  const next = { ...errors };
  for (const key of cleared) delete next[key];
  return next;
}
