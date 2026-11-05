import { isWsTransportDisconnectedError } from "../rpc/wsTransport.errors";

export function workspaceErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const value = error as { message?: unknown; detail?: unknown };
    if (typeof value.message === "string") return value.message;
    if (typeof value.detail === "string") return value.detail;
  }
  return String(error);
}

export function isRetryableWorkspaceError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "retryable" in error) {
    if (typeof error.retryable === "boolean") return error.retryable;
  }
  if (isWsTransportDisconnectedError(error)) return true;
  const message = workspaceErrorDiagnostic(error)
    .split("\n")
    .filter((line) => !/^warning: identity file .* not accessible:/i.test(line.trim()))
    .join("\n");
  if (
    /permission denied|authentication failed|host key verification failed|remote host identification has changed|untrusted host|no such file or directory|\b(?:ENOENT|ENOTDIR|EACCES|NOT_FOUND)\b|outside.*workspace|symlink component/i.test(
      message,
    )
  ) {
    return false;
  }
  // SSH failures cross the RPC boundary as text; exit 255 alone is not retryable.
  return /session request failed|session open refused|connection (?:refused|reset|closed|timed out)|broken pipe|transport (?:closed|disconnected)|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)\b|remote agent.*(?:disconnected|not connected|connection is closed)|websocket.*(?:closed|not connected)|(?:request|command) timed out/i.test(
    message,
  );
}

function workspaceErrorDiagnostic(error: unknown): string {
  const message = workspaceErrorMessage(error);
  // Process failures include the entire shell command before the exit status.
  const failure = /failed \(code=[^)]+\)\.?\s*/i.exec(message);
  if (failure) return message.slice(failure.index + failure[0].length);
  const timeout = / timed out\.(?:\s|$)/i.exec(message);
  if (timeout)
    return `Remote command timed out. ${message.slice(timeout.index + timeout[0].length)}`;
  if (
    /(?:^|:\s)(?:Failed to (?:run|write stdin for) )?(?:\S*[\\/])?ssh(?:\.exe)?\s/i.test(message)
  ) {
    return "The remote SSH command could not complete.";
  }
  return message;
}

export function workspaceErrorSummary(error: unknown): string {
  const message = workspaceErrorDiagnostic(error);
  if (/host key|remote host identification|untrusted host/i.test(message)) {
    return "Verify this workspace’s SSH host key before reconnecting.";
  }
  if (/authentication|permission denied \(publickey/i.test(message)) {
    return "Check this workspace’s SSH authentication before reconnecting.";
  }
  if (/permission denied|\bEACCES\b/i.test(message)) {
    return "You don’t have permission to access these workspace files.";
  }
  if (/no such file or directory|\b(?:ENOENT|ENOTDIR|NOT_FOUND)\b/i.test(message)) {
    return "The workspace path could not be found.";
  }
  return "Couldn’t load workspace files.";
}

export function workspaceErrorDetails(error: unknown): string {
  return workspaceErrorDiagnostic(error)
    .replaceAll(/(?:https?|wss?):\/\/[^\s]+/gi, "[connection address]")
    .replaceAll(
      /\b([\w-]*(?:token|password|secret|authorization|api[_-]?key|private[_-]?key))\s*[:=]\s*(?:(?:Bearer|Basic)\s+\S+|"[^"]*"|'[^']*'|\S+)/gi,
      "$1=[redacted]",
    )
    .slice(0, 2_000);
}
