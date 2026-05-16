import OS from "node:os";
import path from "node:path";

import { resolveExecutionTargetId } from "@bigbud/contracts";

export type SshExecutionTargetAuthMode = "ssh-key" | "password";

export interface SshExecutionTarget {
  readonly executionTargetId: string;
  readonly host: string;
  readonly user?: string;
  readonly port?: string;
  readonly authMode?: SshExecutionTargetAuthMode;
  readonly keyPath?: string;
}

export function parseSshExecutionTarget(
  executionTargetId: string | null | undefined,
): SshExecutionTarget | null {
  const resolved = resolveExecutionTargetId(executionTargetId);
  if (!resolved.startsWith("ssh:")) {
    return null;
  }

  const raw = resolved.slice("ssh:".length).trim();
  if (!raw) {
    return null;
  }

  if (!raw.includes("=")) {
    return {
      executionTargetId: resolved,
      host: raw,
    };
  }

  const params = new URLSearchParams(raw);
  const host = params.get("host")?.trim() ?? "";
  if (!host) {
    return null;
  }

  const user = params.get("user")?.trim() ?? "";
  const port = params.get("port")?.trim() ?? "";
  const authModeRaw = params.get("auth")?.trim();
  const authMode =
    authModeRaw === "ssh-key" || authModeRaw === "password" ? authModeRaw : undefined;
  const keyPath = params.get("keyPath")?.trim() ?? "";

  return {
    executionTargetId: resolved,
    host,
    ...(user ? { user } : {}),
    ...(port ? { port } : {}),
    ...(authMode ? { authMode } : {}),
    ...(keyPath ? { keyPath } : {}),
  };
}

export function formatSshDestination(target: Pick<SshExecutionTarget, "host" | "user">): string {
  return target.user ? `${target.user}@${target.host}` : target.host;
}

export function expandSshKeyPath(keyPath: string): string {
  if (keyPath === "~") {
    return OS.homedir();
  }
  if (keyPath.startsWith("~/") || keyPath.startsWith("~\\")) {
    return path.join(OS.homedir(), keyPath.slice(2));
  }
  return keyPath;
}
