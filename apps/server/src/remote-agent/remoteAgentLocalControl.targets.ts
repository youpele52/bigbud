import { formatSshDestination, parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import { validSshMonitorTarget } from "../ssh/sshMonitor.target.ts";
import { isRemoteAgentExecutionTarget } from "./remoteAgentDefault.ts";

/** Saved projects only contribute their target identity; titles never select a host. */
export interface RemoteAgentSavedTarget {
  readonly executionTargetId: string;
  readonly deleted: boolean;
}

export type RemoteAgentTargetResolution =
  | { readonly ok: true; readonly executionTargetId: string; readonly saved: boolean }
  | { readonly ok: false; readonly message: string };

/** Target IDs and SSH aliases only; shell metacharacters and whitespace are never accepted. */
const SAFE_TARGET_ARGUMENT = /^[A-Za-z0-9@._:=&?%/+~-]{1,512}$/;

/**
 * Resolve a CLI/tool target to one saved agent-transport target ID, or an explicit agent
 * target ID. An alias (`host` or `user@host`) must match exactly one saved target.
 */
export function resolveRemoteAgentTarget(
  argument: string,
  savedTargets: ReadonlyArray<RemoteAgentSavedTarget>,
  options: { readonly savedOnly?: boolean } = {},
): RemoteAgentTargetResolution {
  const resolved = resolveCandidate(argument, savedTargets, options.savedOnly === true);
  // Validate the final SSH argv destination: a decoded host or user beginning with "-", or
  // containing whitespace/controls, could otherwise be read by ssh as an option.
  if (resolved.ok && !validSshMonitorTarget(resolved.executionTargetId)) {
    return { ok: false, message: "The target's SSH host or user is not safe to use." };
  }
  return resolved;
}

function resolveCandidate(
  argument: string,
  savedTargets: ReadonlyArray<RemoteAgentSavedTarget>,
  savedOnly: boolean,
): RemoteAgentTargetResolution {
  const value = argument.trim();
  if (!SAFE_TARGET_ARGUMENT.test(value)) {
    return { ok: false, message: "The target must be a saved target ID or an SSH host alias." };
  }
  const agentTargets = [
    ...new Set(
      savedTargets
        .filter((entry) => !entry.deleted && isRemoteAgentExecutionTarget(entry.executionTargetId))
        .map((entry) => entry.executionTargetId),
    ),
  ];
  if (agentTargets.includes(value)) return { ok: true, executionTargetId: value, saved: true };
  const aliasMatches = agentTargets.filter((target) => {
    const parsed = parseSshExecutionTarget(target);
    return parsed !== null && (parsed.host === value || formatSshDestination(parsed) === value);
  });
  if (aliasMatches.length === 1) {
    return { ok: true, executionTargetId: aliasMatches[0]!, saved: true };
  }
  if (aliasMatches.length > 1) {
    return {
      ok: false,
      message: `'${value}' matches ${aliasMatches.length} saved remote targets. Pass the full target ID instead.`,
    };
  }
  if (!savedOnly && value.startsWith("ssh:") && isRemoteAgentExecutionTarget(value)) {
    return { ok: true, executionTargetId: value, saved: false };
  }
  return {
    ok: false,
    message: `No saved remote project uses the bigbud remote agent on '${value}'. Add it in bigbud first, or pass its full target ID.`,
  };
}

/**
 * D5: a host is already approved when a saved project uses the remote agent for exactly this
 * target identity, or the host's own registry already holds a managed build. Consent is bound to
 * the target's verified SSH identity, never to registry state read from a different target.
 */
export async function isRemoteAgentTargetApproved(input: {
  readonly executionTargetId: string;
  readonly saved: boolean;
  readonly hasManagedBuild: (executionTargetId: string) => Promise<boolean>;
}): Promise<boolean> {
  if (input.saved) return true;
  try {
    return await input.hasManagedBuild(input.executionTargetId);
  } catch {
    // An unreadable registry is not evidence of approval.
    return false;
  }
}
