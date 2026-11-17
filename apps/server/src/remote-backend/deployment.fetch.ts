import { posix } from "node:path";
import { createHash } from "node:crypto";
import { isBackendGraphPath } from "./backendGraph.manifest.ts";
import {
  deploymentError,
  DEPLOYMENT_REQUEST_ID,
  RELAY_HELPER_NAME,
  type DeploymentGraphSource,
  type DeploymentRemoteCommand,
  type DeploymentRemoteRunner,
} from "./deployment.types.ts";

/**
 * Remote staging script. Every install is a new immutable directory published by one rename from a
 * request-scoped staging directory, so a failed or mismatched download never touches a previous
 * install. Exit codes: 65 hash mismatch, 66 unusable archive, 73 conflicting install, 75 download
 * unavailable (laptop fallback), 70 no account home.
 */
export const GRAPH_STAGE_SCRIPT = `set -eu
umask 077
home=$(getent passwd "$(id -u)" | cut -d: -f6)
case "$home" in /*) ;; *) exit 70 ;; esac
base="$home/.bigbud/backend-graphs"
digest() { sha256sum "$1" | cut -d ' ' -f 1; }
op=$1; shift
stage="$base/.staging-$1"
case "$op" in
begin)
  final="$base/$2"
  mkdir -p "$home/.bigbud" "$base"; chmod 700 "$base"
  if [ -f "$final/complete" ] && [ "$(cat "$final/complete")" = "$3 $4" ]; then echo present; exit 0; fi
  if [ -e "$final" ] || [ -L "$final" ]; then exit 73; fi
  rm -rf "$stage"; mkdir "$stage"; echo staged ;;
put)
  cat > "$stage/$2.part"
  if [ "$(digest "$stage/$2.part")" != "$3" ]; then rm -rf "$stage"; exit 65; fi
  mv "$stage/$2.part" "$stage/$2" ;;
put-input)
  dir="$home/.bigbud/backend-setup/$1"; mkdir -p "$dir"; chmod 700 "$home/.bigbud/backend-setup" "$dir"
  cat > "$dir/$2.part"
  if [ "$(digest "$dir/$2.part")" != "$3" ]; then rm -f "$dir/$2.part"; exit 65; fi
  mv "$dir/$2.part" "$dir/$2"; printf 'path=%s\\n' "$dir/$2" ;;
fetch-url)
  curl -fsS --proto =https --proto-redir =https --max-redirs 5 --connect-timeout 20 --max-filesize "$4" -L -o "$stage/archive.part" "$3" || exit 75
  if [ "$(digest "$stage/archive.part")" != "$2" ]; then rm -rf "$stage"; exit 65; fi ;;
fetch-stdin)
  cat > "$stage/archive.part"
  if [ "$(digest "$stage/archive.part")" != "$2" ]; then rm -rf "$stage"; exit 65; fi ;;
commit)
  final="$base/$2"
  if [ "$(digest "$stage/archive.part")" != "$3" ] || [ "$(digest "$stage/manifest.json")" != "$4" ]; then rm -rf "$stage"; exit 65; fi
  mkdir "$stage/graph"
  tar -xzf "$stage/archive.part" -C "$stage/graph" --no-same-owner || { rm -rf "$stage"; exit 66; }
  rm -f "$stage/archive.part"
  for pair in "$5:$6" "$7:$8" "$9:\${10}"; do
    member="$stage/graph/\${pair%%:*}"
    if [ ! -f "$member" ] || [ -L "$member" ] || [ "$(digest "$member")" != "\${pair##*:}" ]; then rm -rf "$stage"; exit 65; fi
  done
  printf '%s %s\\n' "$3" "$4" > "$stage/complete"
  if [ -e "$final" ] || [ -L "$final" ]; then rm -rf "$stage"; exit 73; fi
  mv "$stage" "$final" ;;
*) exit 64 ;;
esac
`;

const ARCHIVE_MAX_BYTES = 2 * 1024 ** 3;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function graphInstallName(source: DeploymentGraphSource): string {
  return `${source.manifest.version}-${source.manifest.target}-${source.archiveSha256.slice(0, 16)}`;
}
export function relayHelperPath(source: DeploymentGraphSource): string {
  const helper = posix.join(posix.dirname(source.manifest.entry), RELAY_HELPER_NAME);
  if (!isBackendGraphPath(helper)) throw deploymentError("graph-unavailable", "Invalid graph.");
  return helper;
}
function member(source: DeploymentGraphSource, path: string) {
  const file = source.manifest.files.find((entry) => entry.path === path);
  if (!file)
    throw deploymentError("graph-unavailable", "The signed graph lacks a required entry point.");
  return file;
}

export interface StagedGraph {
  readonly installDir: string;
  readonly graphRoot: string;
  readonly reused: boolean;
}

/** Download (VPS curl, laptop stdin fallback), hash-verify and publish one immutable install. */
export async function stageRemoteBackendGraph(input: {
  readonly executionTargetId: string;
  readonly requestId: string;
  readonly remoteHome: string;
  readonly source: DeploymentGraphSource;
  readonly run: DeploymentRemoteRunner;
  readonly signal: AbortSignal;
}): Promise<StagedGraph> {
  const { source, requestId, signal } = input;
  if (!DEPLOYMENT_REQUEST_ID.test(requestId))
    throw deploymentError("conflict", "A stable request UUID is required.");
  const name = graphInstallName(source);
  const installDir = `${input.remoteHome}/.bigbud/backend-graphs/${name}`;
  const staged = { installDir, graphRoot: `${installDir}/graph` };
  const pins = [source.manifest.node, source.manifest.entry, relayHelperPath(source)].flatMap(
    (path) => [path, member(source, path).sha256],
  );
  const step = async (
    args: ReadonlyArray<string>,
    extra: Partial<DeploymentRemoteCommand> = {},
    timeoutMs = 60_000,
  ) => {
    signal.throwIfAborted();
    const result = await input.run(
      input.executionTargetId,
      { command: "/bin/sh", args: ["-c", GRAPH_STAGE_SCRIPT, "sh", ...args], timeoutMs, ...extra },
      signal,
    );
    if (result.code === 65)
      throw deploymentError(
        "hash-mismatch",
        "The backend graph did not match its pinned sha256. The previous install is unchanged.",
      );
    if (result.code === 73)
      throw deploymentError("conflict", "An incomplete backend graph install needs repair.");
    if (result.code === 66)
      throw deploymentError("graph-unavailable", "The backend graph archive is unusable.");
    return result;
  };
  const begin = await step(["begin", requestId, name, source.archiveSha256, source.manifestSha256]);
  if (begin.code !== 0)
    throw deploymentError("unavailable", "The remote graph directory is unavailable.");
  if (begin.stdout.trim() === "present") return { ...staged, reused: true };
  const put = await step(["put", requestId, "manifest.json", source.manifestSha256], {
    stdin: { text: source.manifestJson },
  });
  if (put.code !== 0) throw deploymentError("unavailable", "Graph metadata upload failed.");
  let fetched = false;
  if (source.archiveUrl) {
    const result = await step(
      ["fetch-url", requestId, source.archiveSha256, source.archiveUrl, String(ARCHIVE_MAX_BYTES)],
      {},
      30 * 60_000,
    );
    fetched = result.code === 0;
  }
  if (!fetched) {
    // Fallback: stream the pinned archive from the laptop over SSH stdin.
    const local = await source.materializeArchive(signal);
    try {
      const result = await step(
        ["fetch-stdin", requestId, source.archiveSha256],
        { stdin: { path: local.path } },
        30 * 60_000,
      );
      if (result.code !== 0)
        throw deploymentError(
          "unavailable",
          "Uploading the backend graph from this device failed.",
        );
    } finally {
      await local.release();
    }
  }
  const commit = await step(
    ["commit", requestId, name, source.archiveSha256, source.manifestSha256, ...pins],
    {},
    10 * 60_000,
  );
  if (commit.code !== 0)
    throw deploymentError("unavailable", "Publishing the backend graph install failed.");
  return { ...staged, reused: false };
}

/** Per-request owner-private setup inputs, outside the executable graph. */
export async function putRemoteSetupInput(input: {
  readonly executionTargetId: string;
  readonly requestId: string;
  readonly name: "rust-manifest.json" | "trusted-keys.json";
  readonly text: string;
  readonly run: DeploymentRemoteRunner;
  readonly signal: AbortSignal;
}): Promise<string> {
  const result = await input.run(
    input.executionTargetId,
    {
      command: "/bin/sh",
      args: [
        "-c",
        GRAPH_STAGE_SCRIPT,
        "sh",
        "put-input",
        input.requestId,
        input.name,
        sha256(input.text),
      ],
      stdin: { text: input.text },
      timeoutMs: 60_000,
    },
    input.signal,
  );
  const path = /^path=(\/\S+)$/m.exec(result.stdout)?.[1];
  if (result.code !== 0 || !path)
    throw deploymentError("unavailable", "Uploading backend setup inputs failed.");
  return path;
}
