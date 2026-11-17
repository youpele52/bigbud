import * as Schema from "effect/Schema";
import {
  RemoteBackendAuthority,
  RemoteBackendInstallationFingerprint,
} from "@bigbud/contracts/server/remoteBackendHandshake.ts";
import {
  deploymentError,
  REMOTE_ABSOLUTE_PATH,
  type DeploymentRemoteRunner,
} from "./deployment.types.ts";

/** Read-only probe: account home, architecture, SSH host key identity and any finished setup
 * for this request (recovery after the laptop lost the reply). Mutates nothing. */
export const REMOTE_PROBE_SCRIPT = `set -eu
home=$(getent passwd "$(id -u)" | cut -d: -f6)
case "$home" in /*) ;; *) exit 70 ;; esac
printf 'home=%s\\n' "$home"
printf 'arch=%s\\n' "$(uname -m)"
for key in "$2/ssh_host_ed25519_key.pub" "$2/ssh_host_ecdsa_key.pub" "$2/ssh_host_rsa_key.pub"; do
  if [ -r "$key" ]; then printf 'host=%s\\n' "$(cut -d ' ' -f 1,2 "$key" | sha256sum | cut -d ' ' -f 1)"; break; fi
done
for done_file in "$home"/.bigbud/backend-services/*/setup-complete-v1; do
  [ -f "$done_file" ] || continue
  if grep -q "\\"requestId\\":\\"$1\\"" "$done_file"; then printf 'completed=%s\\n' "$(basename "$(dirname "$done_file")")"; fi
done
`;
export const SSH_HOST_KEY_DIR = "/etc/ssh";
const READ_COMPLETION_SCRIPT = `set -eu
home=$(getent passwd "$(id -u)" | cut -d: -f6)
case "$home" in /*) ;; *) exit 70 ;; esac
exec head -c 16384 "$home/.bigbud/backend-services/$1/setup-complete-v1"
`;

export interface RemoteProbe {
  readonly home: string;
  readonly target: "aarch64-unknown-linux-gnu" | "x86_64-unknown-linux-gnu";
  readonly hostIdentity: string;
  readonly completedAuthorityId?: string;
}
const field = (stdout: string, name: string) =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith(`${name}=`))
    .map((line) => line.slice(name.length + 1));

export async function probeRemoteBackendHost(
  run: DeploymentRemoteRunner,
  executionTargetId: string,
  requestId: string,
  signal: AbortSignal,
): Promise<RemoteProbe> {
  const result = await run(
    executionTargetId,
    {
      command: "/bin/sh",
      args: ["-c", REMOTE_PROBE_SCRIPT, "sh", requestId, SSH_HOST_KEY_DIR],
      timeoutMs: 30_000,
    },
    signal,
  );
  if (result.code !== 0) throw deploymentError("unavailable", "The remote host probe failed.");
  const [home] = field(result.stdout, "home");
  const [arch] = field(result.stdout, "arch");
  const [host] = field(result.stdout, "host");
  const completed = field(result.stdout, "completed");
  if (!home || !REMOTE_ABSOLUTE_PATH.test(home) || home.split("/").includes(".."))
    throw deploymentError("unsupported-host", "The remote account home is unsupported.");
  const target =
    arch === "aarch64" || arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : arch === "x86_64" || arch === "amd64"
        ? "x86_64-unknown-linux-gnu"
        : undefined;
  if (!target)
    throw deploymentError("unsupported-host", "The backend tier supports only Linux arm64/x86_64.");
  if (!host || !/^[a-f0-9]{64}$/.test(host))
    throw deploymentError("unsupported-host", "The remote SSH host key could not be identified.");
  if (completed.length > 1 || (completed[0] && !/^[a-f0-9]{32}$/.test(completed[0])))
    throw deploymentError("conflict", "This setup request matches more than one backend.");
  return {
    home,
    target,
    hostIdentity: `sha256:${host}`,
    ...(completed[0] ? { completedAuthorityId: completed[0] } : {}),
  };
}

export interface RemoteSetupPaths {
  readonly home: string;
  readonly installDir: string;
  readonly graphRoot: string;
  readonly nodeBinary: string;
  readonly entry: string;
  readonly rustManifest: string;
  readonly trustedKeys: string;
}
const backendEnv = (home: string) => ({ HOME: home, LANG: "C.UTF-8" });

/** `backend setup` through the graph's own verified Node; returns the configured authority. */
export async function runRemoteBackendSetup(input: {
  readonly run: DeploymentRemoteRunner;
  readonly executionTargetId: string;
  readonly requestId: string;
  readonly paths: RemoteSetupPaths;
  readonly signal: AbortSignal;
}): Promise<string> {
  const { paths } = input;
  const result = await input.run(
    input.executionTargetId,
    {
      command: paths.nodeBinary,
      args: [
        paths.entry,
        "backend",
        "setup",
        "--graph-root",
        paths.graphRoot,
        "--graph-manifest",
        `${paths.installDir}/manifest.json`,
        "--rust-manifest",
        paths.rustManifest,
        "--trusted-keys",
        paths.trustedKeys,
        "--backend-home",
        `${paths.home}/.bigbud/backend`,
        "--request-id",
        input.requestId,
        "--confirm-fresh-setup",
      ],
      env: backendEnv(paths.home),
      timeoutMs: 20 * 60_000,
    },
    input.signal,
  );
  const authority = /^Configured authority: ([a-f0-9]{32})$/m.exec(result.stdout)?.[1];
  if (result.code !== 0 || !authority)
    throw deploymentError(
      "setup-failed",
      "Remote backend setup did not complete. Its state is preserved; inspect `bigbud backend status` on the host.",
    );
  return authority;
}

/** D8: boot startup only with explicit consent; otherwise start for this session only. */
export async function runRemoteBackendStart(input: {
  readonly run: DeploymentRemoteRunner;
  readonly executionTargetId: string;
  readonly authorityId: string;
  readonly enableBoot: boolean;
  readonly paths: Pick<RemoteSetupPaths, "home" | "nodeBinary" | "entry">;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { paths } = input;
  const action = input.enableBoot
    ? ["enable", "--authority", input.authorityId, "--confirm-startup"]
    : ["start", "--authority", input.authorityId];
  const result = await input.run(
    input.executionTargetId,
    {
      command: paths.nodeBinary,
      args: [paths.entry, "backend", ...action],
      env: backendEnv(paths.home),
      timeoutMs: 5 * 60_000,
    },
    input.signal,
  );
  if (result.code !== 0)
    throw deploymentError(
      "setup-failed",
      input.enableBoot
        ? "The backend was configured but enabling boot startup failed."
        : "The backend was configured but starting it failed.",
    );
}

const Completion = Schema.Struct({
  requestId: Schema.String,
  authority: RemoteBackendAuthority,
  installationFingerprint: RemoteBackendInstallationFingerprint,
});
/** The immutable setup completion record pins the initial authority key and installation. */
export async function readRemoteSetupCompletion(input: {
  readonly run: DeploymentRemoteRunner;
  readonly executionTargetId: string;
  readonly authorityId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
}) {
  const result = await input.run(
    input.executionTargetId,
    {
      command: "/bin/sh",
      args: ["-c", READ_COMPLETION_SCRIPT, "sh", input.authorityId],
      timeoutMs: 30_000,
    },
    input.signal,
  );
  let record: typeof Completion.Type;
  try {
    if (result.code !== 0) throw new Error("unreadable");
    record = Schema.decodeUnknownSync(Completion)(JSON.parse(result.stdout));
  } catch {
    throw deploymentError("setup-failed", "The backend setup completion record is unreadable.");
  }
  if (record.requestId !== input.requestId || record.authority.authorityId !== input.authorityId)
    throw deploymentError("conflict", "The backend setup completion belongs to another request.");
  return { authority: record.authority, installationFingerprint: record.installationFingerprint };
}
