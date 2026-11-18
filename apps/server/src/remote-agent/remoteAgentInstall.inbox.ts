import type { RunSshCommandInput } from "../ssh/sshProcess.ts";
import type { RemoteAgentArtifact, RemoteAgentTargetTriple } from "./remoteAgentArtifact.ts";
import { runRemoteAgentDiagnosedCommand } from "./remoteAgentDiagnostics.ts";
import {
  buildRemoteAgentDirectoryGuard,
  buildRemoteAgentInstallPaths,
  buildRemoteAgentStagePrologue,
  type RemoteAgentInstallPaths,
} from "./remoteAgentInstall.ts";

/**
 * Manual placement contract shared with `remote-agent.sh`: verified bytes are published to
 * `~/.bigbud/agent/inbox/<sha256>/bigbud-remote-agent` (owner-only, never executed by the script).
 * The inbox stays outside managed `bin` so orphan reclamation never treats it as a payload.
 */
export const REMOTE_AGENT_INBOX_RELATIVE_ROOT = ".bigbud/agent/inbox";

export type RemoteAgentPlacedState = "managed" | "inbox" | "inbox-conflict" | "absent";

const SAFE_SHA256 = /^[a-f0-9]{64}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

function placedPaths(artifact: Pick<RemoteAgentArtifact, "version" | "sha256" | "sizeBytes">) {
  if (!SAFE_SHA256.test(artifact.sha256) || !SAFE_VERSION.test(artifact.version)) {
    throw new Error("Invalid remote agent artifact identity.");
  }
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) {
    throw new Error("Invalid remote agent artifact size.");
  }
  return {
    installed: `$HOME/.bigbud/agent/bin/${artifact.version}/${artifact.sha256}/bigbud-remote-agent`,
    candidateDirectory: `$HOME/${REMOTE_AGENT_INBOX_RELATIVE_ROOT}/${artifact.sha256}`,
    candidate: `$HOME/${REMOTE_AGENT_INBOX_RELATIVE_ROOT}/${artifact.sha256}/bigbud-remote-agent`,
  };
}

/** `verified_file PATH` succeeds only for an owned regular file with the signed size and hash. */
function verifiedFileFunction(artifact: Pick<RemoteAgentArtifact, "sha256" | "sizeBytes">) {
  return `verified_file() {
  test -f "$1" && test ! -L "$1" || return 1
  test "$(stat -c '%u' "$1")" = "$(id -u)" || return 1
  test "$(wc -c < "$1")" -eq '${artifact.sizeBytes}' || return 1
  test "$(sha256sum "$1" | awk '{print $1}')" = '${artifact.sha256}'
}`;
}

/** Read-only probe run before any download; prints exactly one {@link RemoteAgentPlacedState}. */
export function buildRemoteAgentPlacedProbeScript(
  artifact: Pick<RemoteAgentArtifact, "version" | "sha256" | "sizeBytes">,
): string {
  const paths = placedPaths(artifact);
  return [
    "set -u",
    verifiedFileFunction(artifact),
    `installed=${paths.installed}`,
    `candidate=${paths.candidate}`,
    `if verified_file "$installed" && test "$(stat -c '%a' "$installed")" = 700; then printf managed`,
    `elif [ -e "$candidate" ] || [ -L "$candidate" ]; then`,
    '  if verified_file "$candidate"; then printf inbox; else printf inbox-conflict; fi',
    "else printf absent; fi",
  ].join("\n");
}

export function parseRemoteAgentPlacedState(stdout: string): RemoteAgentPlacedState {
  const token = stdout.trim().split(/\s+/).at(-1);
  return token === "managed" || token === "inbox" || token === "inbox-conflict" ? token : "absent";
}

/**
 * Promote a verified inbox candidate into the immutable managed path under the staging fence.
 * Bytes are copied to a private temporary file and re-verified before the atomic link, so a
 * concurrent writer cannot swap content between check and publication. The candidate is removed
 * only after successful publication; failures preserve it and any working build.
 */
export function buildRemoteAgentInboxPromotionBody(
  artifact: Pick<RemoteAgentArtifact, "version" | "sha256" | "sizeBytes">,
): string {
  const paths = placedPaths(artifact);
  return `${verifiedFileFunction(artifact)}
candidate=${paths.candidate}
candidate_dir=${paths.candidateDirectory}
inbox_root=$root/inbox
test ! -L "$inbox_root/.claim.lock"
exec 8>"$inbox_root/.claim.lock"
flock -n 8 || { printf 'bigbud-install: inbox is busy\\n' >&2; exit 75; }
if [ -e "$installed" ] || [ -L "$installed" ]; then
  verified_file "$installed"
  test "$(stat -c '%a' "$installed")" = "700"
else
  verified_file "$candidate" || { printf 'bigbud-install: inbox candidate missing or does not match the signed build\\n' >&2; exit 66; }
  staged=$(mktemp "$build_root/.bigbud-remote-agent.stage.XXXXXX")
  trap 'rm -f "$staged"' EXIT HUP INT TERM
  cat -- "$candidate" > "$staged"
  verified_file "$staged"
  chmod 700 "$staged"
  sync -f "$staged"
  if ln "$staged" "$installed" 2>/dev/null; then rm -f "$staged"; else
    verified_file "$installed"
    test "$(stat -c '%a' "$installed")" = "700"
    rm -f "$staged"
  fi
  sync -f "$build_root"
  trap - EXIT HUP INT TERM
fi
if verified_file "$candidate"; then rm -f -- "$candidate"; rmdir -- "$candidate_dir" 2>/dev/null || true; fi`;
}

export function buildRemoteAgentInboxAdoptionScript(input: {
  readonly artifact: RemoteAgentArtifact;
  readonly targetTriple: RemoteAgentTargetTriple;
  readonly reservationId?: string;
}): { readonly command: string; readonly paths: RemoteAgentInstallPaths } {
  if (input.artifact.targetTriple !== input.targetTriple) {
    throw new Error("Remote agent artifact target does not match the detected target.");
  }
  const paths = buildRemoteAgentInstallPaths(input.artifact);
  const command = `${buildRemoteAgentStagePrologue(paths, input.reservationId)}
inbox_root=$root/inbox
${buildRemoteAgentDirectoryGuard(`"$inbox_root" "$inbox_root/${input.artifact.sha256}"`)}
install -d -m 700 "$inbox_root"
${buildRemoteAgentInboxPromotionBody(input.artifact)}
`;
  return { command, paths };
}

type RemoteCommandRunner = (input: RunSshCommandInput) => Promise<unknown>;

/** Inspect managed and inbox placement before downloading; never mutates the remote host. */
export async function probeRemoteAgentPlacedArtifact(
  run: RemoteCommandRunner,
  executionTargetId: string,
  artifact: RemoteAgentArtifact,
): Promise<RemoteAgentPlacedState> {
  const { stdout } = await runRemoteAgentDiagnosedCommand(run, "preflight", {
    executionTargetId,
    command: "sh",
    args: ["-lc", buildRemoteAgentPlacedProbeScript(artifact)],
    timeoutMs: 30_000,
    maxBufferBytes: 1024,
  });
  return parseRemoteAgentPlacedState(stdout);
}

/** Promote already-placed bytes without uploading; the caller holds the staging reservation. */
export async function adoptRemoteAgentPlacedArtifact(
  run: RemoteCommandRunner,
  input: {
    readonly executionTargetId: string;
    readonly artifact: RemoteAgentArtifact;
    readonly targetTriple: RemoteAgentTargetTriple;
    readonly reservationId?: string;
  },
): Promise<RemoteAgentInstallPaths> {
  const script = buildRemoteAgentInboxAdoptionScript(input);
  await runRemoteAgentDiagnosedCommand(run, "install", {
    executionTargetId: input.executionTargetId,
    command: "sh",
    args: ["-lc", script.command],
    timeoutMs: 60_000,
    maxBufferBytes: 64 * 1024,
  });
  return script.paths;
}
