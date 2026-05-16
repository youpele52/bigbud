import { LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts";
import type { ProviderRuntimeLocation } from "../../lib/providerExecutionTargets";

export type RemoteProjectAuthMode = "ssh-key" | "password";

export interface RemoteProjectDraft {
  displayName: string;
  host: string;
  username: string;
  port: string;
  workspaceRoot: string;
  sshKeyPath: string;
  authMode: RemoteProjectAuthMode;
  providerRuntimeLocation: ProviderRuntimeLocation;
}

export function isRemoteExecutionTargetId(executionTargetId: string | null | undefined): boolean {
  return (executionTargetId ?? LOCAL_EXECUTION_TARGET_ID) !== LOCAL_EXECUTION_TARGET_ID;
}

export function makeSshExecutionTargetId(remoteTarget: string): string {
  return `ssh:${remoteTarget.trim()}`;
}

export function createDefaultRemoteProjectDraft(): RemoteProjectDraft {
  return {
    displayName: "",
    host: "",
    username: "",
    port: "",
    workspaceRoot: "",
    sshKeyPath: "",
    authMode: "ssh-key",
    providerRuntimeLocation: "local",
  };
}

function parseRemoteExecutionTarget(executionTargetId: string | null | undefined): {
  host: string;
  username: string | null;
  port: string | null;
} | null {
  if (!executionTargetId || !isRemoteExecutionTargetId(executionTargetId)) {
    return null;
  }

  const raw = executionTargetId.replace(/^ssh:/, "");
  if (!raw.includes("=")) {
    return {
      host: raw,
      username: null,
      port: null,
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
  };
}

export function createRemoteProjectExecutionTargetId(draft: RemoteProjectDraft): string {
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

  const sshKeyPath = draft.sshKeyPath.trim();
  if (sshKeyPath.length > 0) {
    params.set("keyPath", sshKeyPath);
  }

  return `ssh:${params.toString()}`;
}

export function createRemoteProjectVerificationKey(draft: RemoteProjectDraft): string {
  return `${createRemoteProjectExecutionTargetId(draft)}::${draft.workspaceRoot.trim()}`;
}

export function getRemoteProjectConnectionLabel(
  draft: Pick<RemoteProjectDraft, "host" | "username" | "port">,
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

export function getProjectRemoteTargetLabel(
  executionTargetId: string | null | undefined,
): string | null {
  const parsed = parseRemoteExecutionTarget(executionTargetId);
  if (!parsed) {
    return null;
  }
  return getRemoteProjectConnectionLabel({
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
