import { LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts";
import {
  resolveProviderRuntimeExecutionTargetId,
  resolveWorkspaceExecutionTargetId,
  type ProviderRuntimeLocation,
} from "../../lib/providerExecutionTargets";
import type { Project } from "../../models/types";

export type RemoteWorkspaceAuthMode = "ssh-key" | "password";
export type RemoteWorkspaceTransport = "agent" | "direct-ssh";
/** How the dialog finds the machine; UI-only, never part of the stored target. */
export type RemoteWorkspaceConnectionSource = "manual" | "ssh-config";

/** Fields each connection source keeps separately so values never leak between modes. */
export interface RemoteWorkspaceConnectionFields {
  host: string;
  username: string;
  port: string;
  sshKeyPath: string;
  authMode: RemoteWorkspaceAuthMode;
}

export interface RemoteWorkspaceDraft extends RemoteWorkspaceConnectionFields {
  displayName: string;
  workspaceRoot: string;
  remoteTransport: RemoteWorkspaceTransport;
  providerRuntimeLocation: ProviderRuntimeLocation;
  connectionSource: RemoteWorkspaceConnectionSource;
  /** Connection fields of the source that is not currently shown. */
  inactiveConnection: RemoteWorkspaceConnectionFields;
}

export type RemoteWorkspaceDraftField = keyof RemoteWorkspaceDraft;

/** Returns whether the error was an SSH lock error and the unlock prompt opened. */
export type RequestRemoteWorkspaceUnlock = (
  errorMessage: string,
  continuation?: () => void,
) => boolean;

export type UpdateRemoteWorkspaceDraft = <K extends RemoteWorkspaceDraftField>(
  field: K,
  value: RemoteWorkspaceDraft[K],
) => void;

function pickRemoteWorkspaceConnection(
  fields: RemoteWorkspaceConnectionFields,
): RemoteWorkspaceConnectionFields {
  return {
    host: fields.host,
    username: fields.username,
    port: fields.port,
    sshKeyPath: fields.sshKeyPath,
    authMode: fields.authMode,
  };
}

function createEmptyRemoteWorkspaceConnection(): RemoteWorkspaceConnectionFields {
  return { host: "", username: "", port: "", sshKeyPath: "", authMode: "ssh-key" };
}

/** Assigns one field; switching the source swaps in that source's own connection fields. */
export function applyRemoteWorkspaceDraftChange<K extends RemoteWorkspaceDraftField>(
  draft: RemoteWorkspaceDraft,
  field: K,
  value: RemoteWorkspaceDraft[K],
): RemoteWorkspaceDraft {
  if (field !== "connectionSource") {
    return { ...draft, [field]: value };
  }
  if (value === draft.connectionSource) {
    return draft;
  }
  return {
    ...draft,
    ...draft.inactiveConnection,
    connectionSource: value as RemoteWorkspaceConnectionSource,
    inactiveConnection: pickRemoteWorkspaceConnection(draft),
  };
}

/** True when any setting would override what the SSH config provides for the host. */
export function hasRemoteWorkspaceConnectionOverrides(
  fields: RemoteWorkspaceConnectionFields,
): boolean {
  return (
    fields.username.trim().length > 0 ||
    fields.port.trim().length > 0 ||
    fields.sshKeyPath.trim().length > 0 ||
    fields.authMode !== "ssh-key"
  );
}

export function isRemoteExecutionTargetId(executionTargetId: string | null | undefined): boolean {
  return (executionTargetId ?? LOCAL_EXECUTION_TARGET_ID) !== LOCAL_EXECUTION_TARGET_ID;
}

export function isSshExecutionTargetId(executionTargetId: string | null | undefined): boolean {
  return executionTargetId?.startsWith("ssh:") === true && executionTargetId.length > 4;
}

export function makeSshExecutionTargetId(remoteTarget: string): string {
  return `ssh:${remoteTarget.trim()}`;
}

export function createDefaultRemoteWorkspaceDraft(
  connectionSource: RemoteWorkspaceConnectionSource = "manual",
): RemoteWorkspaceDraft {
  return {
    ...createEmptyRemoteWorkspaceConnection(),
    displayName: "",
    workspaceRoot: "",
    remoteTransport: "direct-ssh",
    providerRuntimeLocation: "local",
    connectionSource,
    inactiveConnection: createEmptyRemoteWorkspaceConnection(),
  };
}

export function parseRemoteExecutionTarget(executionTargetId: string | null | undefined): {
  host: string;
  username: string | null;
  port: string | null;
  authMode: RemoteWorkspaceAuthMode;
  sshKeyPath: string | null;
  remoteTransport: RemoteWorkspaceTransport;
} | null {
  if (!isSshExecutionTargetId(executionTargetId)) {
    return null;
  }

  const raw = executionTargetId!.slice("ssh:".length);
  if (!raw.includes("=")) {
    return {
      host: raw,
      username: null,
      port: null,
      authMode: "ssh-key",
      sshKeyPath: null,
      remoteTransport: "agent",
    };
  }

  const params = new URLSearchParams(raw);
  const host = params.get("host")?.trim() ?? "";
  if (!host) {
    return null;
  }

  const username = params.get("user")?.trim() ?? "";
  const port = params.get("port")?.trim() ?? "";

  return {
    host,
    username: username.length > 0 ? username : null,
    port: port.length > 0 ? port : null,
    authMode: params.get("auth") === "password" ? "password" : "ssh-key",
    sshKeyPath: params.get("keyPath")?.trim() || null,
    remoteTransport: params.get("transport") === "direct-ssh" ? "direct-ssh" : "agent",
  };
}

export function createRemoteWorkspaceDraft(project: Project): RemoteWorkspaceDraft | null {
  const workspaceExecutionTargetId = resolveWorkspaceExecutionTargetId(project);
  const parsed = parseRemoteExecutionTarget(workspaceExecutionTargetId);
  if (!parsed) {
    return null;
  }

  const connection: RemoteWorkspaceConnectionFields = {
    host: parsed.host,
    username: parsed.username ?? "",
    port: parsed.port ?? "",
    sshKeyPath: parsed.sshKeyPath ?? "",
    authMode: parsed.authMode,
  };
  return {
    ...connection,
    displayName: project.name,
    workspaceRoot: project.cwd ?? "",
    connectionSource: "manual",
    // Both sources start from the stored connection so switching never loses it.
    inactiveConnection: { ...connection },
    remoteTransport: parsed.remoteTransport,
    providerRuntimeLocation:
      resolveProviderRuntimeExecutionTargetId(project) === workspaceExecutionTargetId
        ? "remote"
        : "local",
  };
}

export function createRemoteWorkspaceExecutionTargetId(draft: RemoteWorkspaceDraft): string {
  const params = new URLSearchParams();
  params.set("host", draft.host.trim());

  const username = draft.username.trim();
  if (username.length > 0) {
    params.set("user", username);
  }

  const port = draft.port.trim();
  if (port.length > 0) {
    params.set("port", port);
  }

  params.set("auth", draft.authMode);
  params.set("transport", draft.remoteTransport);

  const sshKeyPath = draft.sshKeyPath.trim();
  if (sshKeyPath.length > 0) {
    params.set("keyPath", sshKeyPath);
  }

  return `ssh:${params.toString()}`;
}

export function createRemoteWorkspaceVerificationKey(draft: RemoteWorkspaceDraft): string {
  return `${createRemoteWorkspaceExecutionTargetId(draft)}::${draft.workspaceRoot.trim()}`;
}

export function getRemoteWorkspaceConnectionLabel(
  draft: Pick<RemoteWorkspaceDraft, "host" | "username" | "port">,
): string {
  const host = draft.host.trim();
  const username = draft.username.trim();
  const port = draft.port.trim();
  const authority = username.length > 0 ? `${username}@${host}` : host;
  if (!port || port === "22") {
    return authority;
  }
  return `${authority}:${port}`;
}

export function getRemoteWorkspaceTargetLabel(
  executionTargetId: string | null | undefined,
): string | null {
  const parsed = parseRemoteExecutionTarget(executionTargetId);
  if (!parsed) {
    return null;
  }
  return getRemoteWorkspaceConnectionLabel({
    host: parsed.host,
    username: parsed.username ?? "",
    port: parsed.port ?? "",
  });
}

export function deriveProjectTitleFromCwd(cwd: string): string {
  const trimmed = cwd.trim();
  const segments = trimmed.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? trimmed;
}

function trimTrailingSlashes(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/u, "") : value;
}

/**
 * True for `/` or the remote home folder: bigbud would watch and search all of it over SSH, and
 * the agent would get the whole folder as its workspace.
 */
export function isBroadRemoteWorkspaceRoot(path: string, homePath: string | null): boolean {
  const normalized = trimTrailingSlashes(path.trim());
  if (normalized === "/" || normalized === "~") return true;
  return homePath !== null && normalized === trimTrailingSlashes(homePath.trim());
}

/** Joins a remote POSIX folder path and a child folder name. */
export function joinRemoteFolderPath(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/** Parent of a remote POSIX folder path; `/` stays `/`. */
export function parentRemoteFolderPath(path: string): string {
  const normalized = trimTrailingSlashes(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}
