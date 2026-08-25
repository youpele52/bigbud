import { type RemoteAgentArtifact, type RemoteAgentTargetTriple } from "./remoteAgentArtifact.ts";
import {
  verifyRemoteAgentArtifactBytes,
  verifyRemoteAgentArtifactSignature,
  type RemoteAgentArtifactTrustStore,
} from "./remoteAgentArtifact.ts";
import { runSshCommand } from "../ssh/sshProcess.ts";

const SAFE_REMOTE_PATH_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export interface RemoteAgentInstallPaths {
  readonly root: string;
  readonly binRoot: string;
  readonly stateRoot: string;
  readonly versionRoot: string;
  readonly stagedBinary: string;
  readonly installedBinary: string;
  readonly activeLink: string;
  readonly previousLink: string;
}

export interface RemoteAgentInstallScriptInput {
  readonly artifact: RemoteAgentArtifact;
  readonly targetTriple: RemoteAgentTargetTriple;
  readonly stagedBase64: string;
}

export function buildRemoteAgentInstallPaths(version: string): RemoteAgentInstallPaths {
  if (!SAFE_REMOTE_PATH_VERSION.test(version)) {
    throw new Error(`Invalid remote agent version '${version}'.`);
  }
  const root = "$HOME/.bigbud/agent";
  const binRoot = `${root}/bin`;
  const stateRoot = `${root}/state`;
  const versionRoot = `${binRoot}/${version}`;
  return {
    root,
    binRoot,
    stateRoot,
    versionRoot,
    stagedBinary: `${versionRoot}/.bigbud-remote-agent.stage.$$.bin`,
    installedBinary: `${versionRoot}/bigbud-remote-agent`,
    activeLink: `${binRoot}/current`,
    previousLink: `${binRoot}/previous`,
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
  const paths = buildRemoteAgentInstallPaths(input.artifact.version);
  const command = `
set -eu
umask 077
root=${paths.root}
bin_root=${paths.binRoot}
state_root=${paths.stateRoot}
version_root=${paths.versionRoot}
staged=${paths.stagedBinary}
installed=${paths.installedBinary}
for path in "$root" "$bin_root" "$state_root" "$version_root"; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    test ! -L "$path"
    test -d "$path"
    test "$(stat -c '%u' "$path")" = "$(id -u)"
    test "$(stat -c '%a' "$path")" = "700"
  fi
done
install -d -m 700 "$root" "$bin_root" "$state_root" "$version_root"
base64 --decode > "$staged"
test "$(wc -c < "$staged")" -eq '${input.artifact.sizeBytes}'
test "$(sha256sum "$staged" | awk '{print $1}')" = '${input.artifact.sha256}'
chmod 700 "$staged"
mv -f "$staged" "$installed"
printf '%s\\n' '${input.targetTriple}' > "$version_root/target-triple"
`;
  return { command, stdin: input.stagedBase64, paths };
}

function assertSafeInstallVersion(version: string): void {
  if (!SAFE_REMOTE_PATH_VERSION.test(version)) {
    throw new Error(`Invalid remote agent version '${version}'.`);
  }
}

export function buildRemoteAgentActivationScript(version: string): string {
  assertSafeInstallVersion(version);
  const paths = buildRemoteAgentInstallPaths(version);
  const temporaryLink = `${paths.activeLink}.$$.tmp`;
  const previousTemporaryLink = `${paths.previousLink}.$$.tmp`;
  return `
set -eu
umask 077
bin_root=${paths.binRoot}
installed=${paths.installedBinary}
active=${paths.activeLink}
previous=${paths.previousLink}
temporary=${temporaryLink}
previous_temporary=${previousTemporaryLink}
test -f "$installed"
test ! -L "$installed"
test "$(stat -c '%u' "$installed")" = "$(id -u)"
test "$(stat -c '%a' "$installed")" = "700"
if { [ -e "$active" ] || [ -L "$active" ]; } && [ ! -L "$active" ]; then exit 1; fi
if { [ -e "$previous" ] || [ -L "$previous" ]; } && [ ! -L "$previous" ]; then exit 1; fi
if [ -L "$active" ]; then
  current_target=$(readlink "$active")
  case "$current_target" in
    "$bin_root"/*) ;;
    *) exit 1 ;;
  esac
  ln -s "$current_target" "$previous_temporary"
  mv -Tf "$previous_temporary" "$previous"
fi
ln -s "$installed" "$temporary"
mv -Tf "$temporary" "$active"
`;
}

export function buildRemoteAgentCandidateCheckScript(version: string): string {
  assertSafeInstallVersion(version);
  const paths = buildRemoteAgentInstallPaths(version);
  return [
    "set -eu",
    `active=${paths.activeLink}`,
    'test -x "$active"',
    'exec "$active" --check',
  ].join("\n");
}

export function buildRemoteAgentRollbackScript(): string {
  const paths = buildRemoteAgentInstallPaths("rollback");
  const temporaryLink = `${paths.activeLink}.$$.rollback.tmp`;
  const previousTemporaryLink = `${paths.previousLink}.$$.rollback.tmp`;
  return `
set -eu
umask 077
bin_root=${paths.binRoot}
active=${paths.activeLink}
previous=${paths.previousLink}
temporary=${temporaryLink}
previous_temporary=${previousTemporaryLink}
if [ ! -L "$previous" ]; then exit 0; fi
if { [ -e "$active" ] || [ -L "$active" ]; } && [ ! -L "$active" ]; then exit 1; fi
previous_target=$(readlink "$previous")
case "$previous_target" in
  "$bin_root"/*) ;;
  *) exit 1 ;;
esac
if [ -L "$active" ]; then
  active_target=$(readlink "$active")
  case "$active_target" in
    "$bin_root"/*) ;;
    *) exit 1 ;;
  esac
  ln -s "$active_target" "$previous_temporary"
  mv -Tf "$previous_temporary" "$previous"
fi
ln -s "$previous_target" "$temporary"
mv -Tf "$temporary" "$active"
`;
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
