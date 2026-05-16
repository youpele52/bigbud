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
    errors.host = "Enter an SSH host, IP, or SSH config host.";
  }
  const port = draft.port.trim();
  if (port.length > 0) {
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
      errors.port = "Port must be a whole number between 1 and 65535.";
    }
  }
  if (draft.workspaceRoot.trim().length === 0) {
    errors.workspaceRoot = "Enter the remote project path.";
  }
  return errors;
}

export function hasRemoteProjectFieldErrors(errors: RemoteProjectFieldErrors): boolean {
  return Object.values(errors).some((value) => typeof value === "string" && value.length > 0);
}
