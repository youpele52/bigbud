import { createInterface } from "node:readline/promises";

import type { RemoteAgentOperationSnapshot } from "../remote-agent/remoteAgentInstall.operation.ts";
import {
  RemoteAgentBackendUnavailableError,
  sendRemoteAgentControlRequest,
} from "../remote-agent/remoteAgentLocalControl.client.ts";

export const REPLACE_FLAG_CONFLICT = "--replace and --keep-previous cannot be used together.";
export const KEEP_PREVIOUS_HINT =
  "Older agent builds are kept. Pass --replace to retire them after the new build is active (or --keep-previous to skip this hint).";
const STATUS_TIMEOUT_MS = 60_000;

export function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Ask one [y/N] question; anything but y/yes, or a non-interactive terminal, is no. */
export async function askYesNo(question: string): Promise<boolean> {
  if (!isInteractiveTerminal()) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

/**
 * Version of the installed build that would become the older build, from a read-only status
 * reply. Unapproved hosts, fresh hosts and a host already running this version have none.
 */
export function olderInstalledVersion(result: unknown, newVersion: string): string | null {
  if (typeof result !== "object" || result === null) return null;
  const status = result as {
    readonly approved?: unknown;
    readonly health?: { readonly current?: { readonly version?: unknown } | null } | null;
  };
  if (status.approved !== true) return null;
  const installed = status.health?.current?.version;
  return typeof installed === "string" && installed !== newVersion ? installed : null;
}

/**
 * Decide whether older builds are retired after activation. Explicit flags win; otherwise an
 * interactive person is asked only when status shows an older build on an approved host. Every
 * other case keeps older builds (the safe default) with a one-line hint.
 */
export async function resolveReplaceChoice(input: {
  readonly socketPath: string;
  readonly target: string;
  readonly replace: boolean;
  readonly keepPrevious: boolean;
  readonly json: boolean;
  readonly agentVersion: string;
  readonly hint: (line: string) => void;
}): Promise<boolean> {
  if (input.replace) return true;
  if (input.keepPrevious) return false;
  if (input.json || !isInteractiveTerminal()) {
    input.hint(KEEP_PREVIOUS_HINT);
    return false;
  }
  let readable = false;
  let older: string | null = null;
  try {
    const response = await sendRemoteAgentControlRequest(
      input.socketPath,
      { method: "status", target: input.target },
      STATUS_TIMEOUT_MS,
    );
    if (response.ok) {
      readable = (response.result as { approved?: unknown } | null)?.approved === true;
      older = olderInstalledVersion(response.result, input.agentVersion);
    }
  } catch (cause) {
    if (cause instanceof RemoteAgentBackendUnavailableError) throw cause;
    // Unreadable status skips the question; the install itself reports the real failure.
  }
  if (older) {
    return askYesNo(
      `An older agent build (${older}) is installed on ${input.target}. Replace it after the new one is active? [y/N] `,
    );
  }
  if (!readable) input.hint(KEEP_PREVIOUS_HINT);
  return false;
}

/** Actionable follow-up for an operation stopped by the host's two-build capacity. */
export function capacityHint(
  snapshot: RemoteAgentOperationSnapshot,
  replace: boolean,
): string | null {
  if (snapshot.failureKind !== "capacity-deferred") return null;
  return replace
    ? "The host already holds two agent builds and live work still uses the older one, so no slot could be freed. Retry after that work ends."
    : "The host already holds two agent builds and live work still uses the older one, so no slot could be freed. Retry after that work ends, and use --replace on future installs so older builds do not accumulate.";
}
