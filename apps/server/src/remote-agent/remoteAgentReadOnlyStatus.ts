import { runSshCommand, type RunSshCommandInput } from "../ssh/sshProcess.ts";
import { runRemoteAgentDiagnosedCommand } from "./remoteAgentDiagnostics.ts";
import {
  MAX_REMOTE_AGENT_REGISTRY_BYTES,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";

/**
 * Read-only remote-agent facts for `status`, `doctor` and D5 approval: one `cat` of the registry.
 * No directory creation, no lock, no pooled connection and no supervisor start or contact.
 */
export function buildRemoteAgentRegistryReadOnlyProbe(): string {
  return [
    'test -d "$HOME" && test -x "$HOME" || { printf unreadable; exit 0; }',
    'for d in "$HOME/.bigbud" "$HOME/.bigbud/agent" "$HOME/.bigbud/agent/control-v1"; do',
    '  if [ ! -e "$d" ] && [ ! -L "$d" ]; then printf absent; exit 0; fi',
    '  test -d "$d" && test ! -L "$d" && test -x "$d" || { printf unreadable; exit 0; }',
    "done",
    'f="$HOME/.bigbud/agent/control-v1/registry.json"',
    'if [ ! -e "$f" ] && [ ! -L "$f" ]; then printf absent',
    `elif [ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] && [ "$(wc -c < "$f")" -le ${MAX_REMOTE_AGENT_REGISTRY_BYTES} ]; then cat -- "$f"`,
    "else printf unreadable; fi",
  ].join("\n");
}

/** `null` when there is no registry; throws when the registry exists but cannot be parsed. */
export async function readRemoteAgentRegistryReadOnly(
  executionTargetId: string,
  run: (input: RunSshCommandInput) => Promise<unknown> = runSshCommand,
  timeoutMs = 15_000,
): Promise<RemoteAgentRegistry | null> {
  const { stdout } = await runRemoteAgentDiagnosedCommand(run, "preflight", {
    executionTargetId,
    command: "sh",
    args: ["-c", buildRemoteAgentRegistryReadOnlyProbe()],
    timeoutMs,
    maxBufferBytes: MAX_REMOTE_AGENT_REGISTRY_BYTES + 16,
  });
  return stdout.trim() === "absent" ? null : parseRemoteAgentRegistry(stdout);
}

export interface RemoteAgentReadOnlyStatus {
  readonly status: "not-installed" | "installed";
  readonly current: RemoteAgentBuildSummary | null;
  readonly pending: RemoteAgentBuildSummary | null;
  /** Older bigbud-managed builds whose bytes remain (present or mid-deletion). */
  readonly olderBuilds: number;
  readonly note: string;
}

interface RemoteAgentBuildSummary {
  readonly version: string;
  readonly targetTriple: string;
  readonly health: string;
}

export function summarizeRemoteAgentRegistry(
  state: RemoteAgentRegistry | null,
): RemoteAgentReadOnlyStatus {
  const note =
    "Read from the remote registry without connecting to the agent; liveness is not checked.";
  if (!state)
    return { status: "not-installed", current: null, pending: null, olderBuilds: 0, note };
  const summary = (id: string | null): RemoteAgentBuildSummary | null => {
    const build = id ? state.builds.find((entry) => entry.id === id) : undefined;
    return build
      ? {
          version: build.runtime.version,
          targetTriple: build.runtime.targetTriple,
          health: build.health,
        }
      : null;
  };
  const current = summary(state.current);
  return {
    status: current ? "installed" : "not-installed",
    current,
    pending: summary(state.pending),
    olderBuilds: state.builds.filter(
      (build) =>
        build.runtime.origin === "managed" &&
        (build.binary === "present" || build.binary === "deleting") &&
        build.id !== state.current &&
        build.id !== state.pending,
    ).length,
    note,
  };
}

export async function remoteAgentReadOnlyStatus(
  executionTargetId: string,
  run?: (input: RunSshCommandInput) => Promise<unknown>,
  timeoutMs?: number,
): Promise<RemoteAgentReadOnlyStatus> {
  return summarizeRemoteAgentRegistry(
    await readRemoteAgentRegistryReadOnly(executionTargetId, run, timeoutMs),
  );
}
