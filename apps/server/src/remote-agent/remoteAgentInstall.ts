import { type RemoteAgentArtifact, type RemoteAgentTargetTriple } from "./remoteAgentArtifact.ts";
import {
  verifyRemoteAgentArtifactBytes,
  verifyRemoteAgentArtifactSignature,
  type RemoteAgentArtifactTrustStore,
} from "./remoteAgentArtifact.ts";
import { runSshCommand } from "../ssh/sshProcess.ts";

const SAFE_REMOTE_PATH_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_ARTIFACT_SHA256 = /^[a-f0-9]{64}$/;

export type RemoteAgentBuildIdentity = Pick<RemoteAgentArtifact, "version" | "sha256">;

export interface RemoteAgentInstallPaths {
  readonly root: string;
  readonly binRoot: string;
  readonly stateRoot: string;
  readonly versionRoot: string;
  readonly buildRoot: string;
  readonly installedBinary: string;
  readonly activeLink: string;
  readonly previousLink: string;
}

export interface RemoteAgentInstallScriptInput {
  readonly artifact: RemoteAgentArtifact;
  readonly targetTriple: RemoteAgentTargetTriple;
  readonly stagedBase64: string;
}

function buildRemoteAgentInstallRoots() {
  const root = "$HOME/.bigbud/agent";
  const binRoot = `${root}/bin`;
  return {
    root,
    binRoot,
    stateRoot: `${root}/state`,
    activeLink: `${binRoot}/current`,
    previousLink: `${binRoot}/previous`,
  };
}

export function buildRemoteAgentTrustedTargetValidator(): string {
  return `
validate_agent_target() {
  target=$1
  case "$target" in
    /*) ;;
    *) return 1 ;;
  esac
  canonical=$(readlink -f -- "$target")
  case "$canonical" in
    "$bin_root_canonical"/*) ;;
    *) return 1 ;;
  esac
  relative=\${canonical#"$bin_root_canonical"/}
  case "$relative" in
    */bigbud-remote-agent) ;;
    *) return 1 ;;
  esac
  directory=\${relative%/bigbud-remote-agent}
  case "$directory" in
    */*)
      version=\${directory%%/*}
      sha256=\${directory#*/}
      test "\${#sha256}" -eq 64
      case "$sha256" in *[!a-f0-9]*) return 1 ;; esac
      ;;
    *) version=$directory ;;
  esac
  test -n "$version"
  test "\${#version}" -le 64
  case "$version" in
    [A-Za-z0-9]*) ;;
    *) return 1 ;;
  esac
  case "$version" in *[!A-Za-z0-9._+-]*) return 1 ;; esac
  test -f "$canonical"
  test ! -L "$canonical"
  test "$(stat -c '%u' "$canonical")" = "$(id -u)"
  test "$(stat -c '%a' "$canonical")" = "700"
  printf '%s\n' "$canonical"
}
`;
}

export function buildRemoteAgentInstallPaths(
  identity: RemoteAgentBuildIdentity,
): RemoteAgentInstallPaths {
  if (!SAFE_REMOTE_PATH_VERSION.test(identity.version)) {
    throw new Error(`Invalid remote agent version '${identity.version}'.`);
  }
  if (!SAFE_ARTIFACT_SHA256.test(identity.sha256)) {
    throw new Error("Invalid remote agent artifact SHA-256 digest.");
  }
  const { root, binRoot, stateRoot, activeLink, previousLink } = buildRemoteAgentInstallRoots();
  const versionRoot = `${binRoot}/${identity.version}`;
  const buildRoot = `${versionRoot}/${identity.sha256}`;
  return {
    root,
    binRoot,
    stateRoot,
    versionRoot,
    buildRoot,
    installedBinary: `${buildRoot}/bigbud-remote-agent`,
    activeLink,
    previousLink,
  };
}

export function buildRemoteAgentInstallScript(input: RemoteAgentInstallScriptInput): {
  readonly command: string;
  readonly stdin: string;
  readonly paths: RemoteAgentInstallPaths;
} {
  if (input.artifact.targetTriple !== input.targetTriple) {
    throw new Error("Remote agent artifact target does not match the detected target.");
  }
  if (input.stagedBase64.length === 0) {
    throw new Error("Remote agent installation payload cannot be empty.");
  }
  const paths = buildRemoteAgentInstallPaths(input.artifact);
  const command = `
set -eu
umask 077
root=${paths.root}
bin_root=${paths.binRoot}
state_root=${paths.stateRoot}
version_root=${paths.versionRoot}
build_root=${paths.buildRoot}
installed=${paths.installedBinary}
for path in "$root" "$bin_root" "$state_root" "$version_root" "$build_root"; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    test ! -L "$path"
    test -d "$path"
    test "$(stat -c '%u' "$path")" = "$(id -u)"
    test "$(stat -c '%a' "$path")" = "700"
  fi
done
install -d -m 700 "$root" "$bin_root" "$state_root" "$version_root" "$build_root"
staged=$(mktemp "$build_root/.bigbud-remote-agent.stage.XXXXXX")
trap 'rm -f "$staged"' EXIT HUP INT TERM
base64 --decode > "$staged"
test "$(wc -c < "$staged")" -eq '${input.artifact.sizeBytes}'
test "$(sha256sum "$staged" | awk '{print $1}')" = '${input.artifact.sha256}'
chmod 700 "$staged"
if ln "$staged" "$installed" 2>/dev/null; then
  rm -f "$staged"
else
  test -e "$installed"
  test ! -L "$installed"
  test -f "$installed"
  test "$(stat -c '%u' "$installed")" = "$(id -u)"
  test "$(stat -c '%a' "$installed")" = "700"
  test "$(wc -c < "$installed")" -eq '${input.artifact.sizeBytes}'
  test "$(sha256sum "$installed" | awk '{print $1}')" = '${input.artifact.sha256}'
  rm -f "$staged"
fi
trap - EXIT HUP INT TERM
`;
  return { command, stdin: input.stagedBase64, paths };
}

export function buildRemoteAgentCandidateCheckScript(): string {
  const paths = buildRemoteAgentInstallRoots();
  return [
    "set -eu",
    `active=${paths.activeLink}`,
    'test -x "$active"',
    'exec "$active" --check',
  ].join("\n");
}

export async function installRemoteAgentArtifact(input: {
  readonly executionTargetId: string;
  readonly artifact: RemoteAgentArtifact;
  readonly targetTriple: RemoteAgentTargetTriple;
  readonly bytes: Uint8Array;
  readonly trustStore: RemoteAgentArtifactTrustStore;
  readonly skipSignatureVerification?: boolean;
}): Promise<RemoteAgentInstallPaths> {
  if (!input.skipSignatureVerification) {
    verifyRemoteAgentArtifactSignature(input.artifact, input.trustStore);
  }
  verifyRemoteAgentArtifactBytes(input.artifact, input.bytes);
  const script = buildRemoteAgentInstallScript({
    artifact: input.artifact,
    targetTriple: input.targetTriple,
    stagedBase64: Buffer.from(input.bytes).toString("base64"),
  });
  await runSshCommand({
    executionTargetId: input.executionTargetId,
    command: "sh",
    args: ["-lc", script.command],
    stdin: script.stdin,
    timeoutMs: 60_000,
    maxBufferBytes: 64 * 1024,
    outputMode: "truncate",
  });
  return script.paths;
}
