import { createHash } from "node:crypto";
import path from "node:path";
import posixPath from "node:path/posix";

export const REMOTE_WORKSPACE_SESSION_STATE_PATH = ".bigbud/session-state";

export function remoteWorkspaceSessionFsInvocationId(
  sessionId: string,
  operation: string,
  paths: ReadonlyArray<string>,
  sequence: number,
): string {
  if (!/^[\x21-\x7e]{1,200}$/.test(sessionId))
    throw new Error("Copilot session filesystem identity is unavailable.");
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error("Copilot session filesystem operation sequence is unavailable.");
  const identity = `copilot-fs:${sessionId}:${sequence}:${operation}:${paths.map((value) => encodeURIComponent(value)).join(":")}`;
  return identity.length <= 200
    ? identity
    : `copilot-fs:${createHash("sha256").update(identity).digest("hex")}`;
}

export function createErrnoError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

export interface ResolvedSessionFsPath {
  readonly kind: "session-state" | "workspace";
  readonly path: string;
}

function isSessionStatePath(pathname: string): boolean {
  return (
    pathname === REMOTE_WORKSPACE_SESSION_STATE_PATH ||
    pathname.startsWith(`${REMOTE_WORKSPACE_SESSION_STATE_PATH}/`)
  );
}

export function resolveSessionFsPath(
  inputPath: string,
  initialCwd: string,
  bridgeCwd?: string,
): ResolvedSessionFsPath {
  const normalizedPath = posixPath.normalize(inputPath);
  if (isSessionStatePath(normalizedPath)) return { kind: "session-state", path: normalizedPath };
  if (bridgeCwd && (normalizedPath === bridgeCwd || normalizedPath.startsWith(`${bridgeCwd}/`))) {
    return {
      kind: "workspace",
      path: posixPath.resolve(initialCwd, posixPath.relative(bridgeCwd, normalizedPath)),
    };
  }
  return {
    kind: "workspace",
    path: posixPath.isAbsolute(normalizedPath)
      ? normalizedPath
      : posixPath.resolve(initialCwd, normalizedPath),
  };
}

export function resolveSessionStateFsPath(pathname: string, stateRoot: string): string {
  const relativePath =
    pathname === REMOTE_WORKSPACE_SESSION_STATE_PATH
      ? "."
      : pathname.slice(REMOTE_WORKSPACE_SESSION_STATE_PATH.length + 1);
  const resolved = path.resolve(stateRoot, relativePath);
  const normalizedRoot = path.resolve(stateRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`))
    throw createErrnoError("EPERM", `Path escapes session state root: ${pathname}`);
  return resolved;
}
