import {
  findRemoteAgentRemoteCommandError,
  type RemoteAgentRemoteCommandError,
} from "./remoteAgentDiagnostics.ts";

export type RemoteAgentFailureKind =
  | "glibc-too-old"
  | "missing-tool"
  | "directory-permissions"
  | "upload-timeout"
  | "capacity-deferred"
  | "unsupported-platform"
  | "install-in-progress"
  | "inbox-mismatch"
  | "remote-command"
  | "ssh-host-trust";

export interface RemoteAgentFailureClassification {
  readonly kind: RemoteAgentFailureKind;
  readonly message: string;
}

/** Marker printed by bigbud install/preflight scripts before refusing an unsafe directory. */
export const REMOTE_AGENT_UNSAFE_DIRECTORY_MARKER = "bigbud-install: unsafe-directory";
/** Exit status used by the install script when a staging reservation is already held. */
export const REMOTE_AGENT_RESERVATION_BUSY_EXIT = 75;

const GNU_TOOL_HINT: Readonly<Record<string, string>> = {
  stat: "GNU coreutils `stat -c`",
  readlink: "GNU coreutils `readlink -f`",
  sync: "GNU coreutils `sync -f`",
  install: "GNU coreutils `install -d`",
  sha256sum: "`sha256sum`",
  flock: "`flock` (util-linux)",
  base64: "`base64`",
  mktemp: "`mktemp`",
  awk: "`awk`",
};

function missingToolFrom(stderr: string): string | null {
  const notFound = stderr.match(
    /(?:^|[\s:])([A-Za-z0-9_.-]+): (?:command not found|not found)\b/m,
  )?.[1];
  if (notFound && GNU_TOOL_HINT[notFound]) return notFound;
  const unsupported = stderr.match(
    /(?:^|\s)(stat|readlink|sync|install)(?::)? (?:illegal|invalid|unrecognized) option/m,
  )?.[1];
  return unsupported ?? null;
}

function directoryIssueFrom(stderr: string): string | null {
  const line = stderr
    .split("\n")
    .find((entry) => entry.startsWith(REMOTE_AGENT_UNSAFE_DIRECTORY_MARKER));
  if (!line) return null;
  const [label = "~/.bigbud/agent", ...facts] = line
    .slice(REMOTE_AGENT_UNSAFE_DIRECTORY_MARKER.length)
    .trim()
    .split(/\s+/);
  const detail = facts.join(", ");
  return `The remote directory ~/${label} must be a real directory owned by the SSH account with mode 700${
    detail ? ` (found ${detail})` : ""
  }. Run \`chmod 700 ~/${label}\` on the remote host, or fix its ownership, then retry.`;
}

/** The loader lists every missing symbol version; the highest is the real floor. */
function highestGlibcRequirement(stderr: string): string | null {
  const versions = [...stderr.matchAll(/GLIBC_(\d+)\.(\d+)'? not found/g)].map(
    (match) => [Number(match[1]), Number(match[2])] as const,
  );
  const highest = versions.reduce<readonly [number, number] | null>(
    (best, next) =>
      best === null || next[0] > best[0] || (next[0] === best[0] && next[1] > best[1])
        ? next
        : best,
    null,
  );
  return highest ? `${highest[0]}.${highest[1]}` : null;
}

function lastMeaningfulLine(stderr: string): string | null {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("+"));
  return lines.at(-1)?.slice(0, 300) ?? null;
}

function classifyRemoteCommand(
  error: RemoteAgentRemoteCommandError,
): RemoteAgentFailureClassification {
  const stderr = error.stderrTail;
  const glibc = highestGlibcRequirement(stderr);
  if (glibc) {
    return {
      kind: "glibc-too-old",
      message: `The remote system's glibc is older than this agent build requires (needs GLIBC_${glibc}). Use a static (musl) agent build or a newer Linux distribution.`,
    };
  }
  if (stderr.includes("bigbud-install: inbox candidate")) {
    return {
      kind: "inbox-mismatch",
      message:
        "The manually placed agent is missing or does not match the signed release. Remove it from ~/.bigbud/agent/inbox on the remote host, run the copied command again, then retry.",
    };
  }
  const directory = directoryIssueFrom(stderr);
  if (directory) return { kind: "directory-permissions", message: directory };
  const tool = missingToolFrom(stderr);
  if (tool) {
    return {
      kind: "missing-tool",
      message: `The remote host is missing ${GNU_TOOL_HINT[tool] ?? `\`${tool}\``}, which agent installation requires. Install it on the remote host, then retry.`,
    };
  }
  if (error.timedOut && error.stage === "install") {
    return {
      kind: "upload-timeout",
      message:
        "Uploading the agent to the remote host timed out. Check the connection speed, or place the agent on the remote host manually and retry.",
    };
  }
  if (error.stage === "install" && error.exitCode === REMOTE_AGENT_RESERVATION_BUSY_EXIT) {
    return {
      kind: "install-in-progress",
      message: "Another bigbud installation is already staging this agent build. Retry shortly.",
    };
  }
  const line = lastMeaningfulLine(stderr);
  return {
    kind: "remote-command",
    message: line ? `${error.message.replace(/\.$/, "")}: ${line}` : error.message,
  };
}

/** Map a setup failure to a plain, user-actionable message; null when not a known shape. */
export function classifyRemoteAgentFailure(
  cause: unknown,
): RemoteAgentFailureClassification | null {
  const remote = findRemoteAgentRemoteCommandError(cause);
  if (remote) return classifyRemoteCommand(remote);
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current.message.startsWith("SSH host trust is required:"))
      return {
        kind: "ssh-host-trust",
        message:
          "The SSH server identity is not trusted yet. Verify its host key in bigbud's remote connection setup, then retry.",
      };
    if (current.message.startsWith("The SSH server's identity has changed or was revoked."))
      return {
        kind: "ssh-host-trust",
        message:
          "The SSH server's identity has changed or was revoked. Connection blocked. Verify the server with your administrator before updating known_hosts.",
      };
    const tag = (current as { readonly _tag?: unknown })._tag;
    if (tag === "RemoteAgentPreflightError") {
      const kind = (current as { readonly kind?: RemoteAgentFailureKind }).kind;
      return { kind: kind ?? "remote-command", message: current.message };
    }
    if (tag === "RemoteAgentCapacityUnavailableError") {
      return { kind: "capacity-deferred", message: current.message };
    }
    if (tag === "RemoteAgentInstallManagerError" && /\bis unsupported on\b/.test(current.message)) {
      return { kind: "unsupported-platform", message: current.message };
    }
    current = current.cause;
  }
  return null;
}
