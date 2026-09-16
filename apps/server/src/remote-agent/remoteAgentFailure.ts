/** Keep setup errors actionable without exposing remote shell scripts or response bodies. */
export function remoteAgentFailureDetail(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "Remote agent setup failed.";
  if (/\bssh\s+-|\bCommand failed:/.test(message)) {
    const code = message.match(/(?:code=|exited )(\d+)/)?.[1];
    return `The SSH setup command failed${code ? ` (exit ${code})` : ""}. Verify remote access and agent directory permissions.`;
  }
  return (
    message
      .split("\n", 1)[0]!
      // Strip terminal control characters before displaying a remote failure.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .slice(0, 512)
  );
}

export function remoteAgentFailureMessage(cause: unknown): string {
  const detail = remoteAgentFailureDetail(cause).trimEnd();
  return `${detail}${/[.!?]$/.test(detail) ? "" : "."} You can switch Connection method to Direct SSH in the remote project settings.`;
}
