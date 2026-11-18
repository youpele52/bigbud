import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RemoteBackendProfileRecord } from "../persistence/Services/RemoteBackendProfiles.ts";
import {
  canonicalBackendGraphPayload,
  decodeBackendGraphManifest,
} from "./backendGraph.manifest.ts";
import { runBoundedProcess } from "./deployment.ssh.ts";
import { SSH_HOST_KEY_DIR } from "./deployment.remoteSetup.ts";
import type {
  DeploymentGraphSource,
  DeploymentProfileStore,
  DeploymentRemoteCommand,
  DeploymentRemoteRunner,
} from "./deployment.types.ts";

export const TARGET = "ssh:host=vps.example&user=dev&transport=agent";
export const AUTHORITY = "0123456789abcdef0123456789abcdef";
export const KEY_FINGERPRINT = `sha256:${"b".repeat(64)}`;
export const INSTALLATION = `sha256:${"c".repeat(64)}`;
export const REQUEST = "11111111-2222-4333-8444-555555555555";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Fake graph Node: records backend CLI calls and writes the setup completion record. */
const FAKE_NODE = `#!/bin/sh
set -eu
shift
[ "$1" = backend ] || exit 2
op=$2; shift 2
log="$HOME/.fake-backend.log"
case "$op" in
setup)
  req=""
  while [ $# -gt 0 ]; do case "$1" in --request-id) req=$2; shift 2 ;; *) shift ;; esac; done
  dir="$HOME/.bigbud/backend-services/${AUTHORITY}"; mkdir -p "$dir"
  printf '{"version":1,"requestId":"%s","authority":{"authorityId":"${AUTHORITY}","keyEpoch":1,"keyFingerprint":"${KEY_FINGERPRINT}"},"installationFingerprint":"${INSTALLATION}"}\\n' "$req" > "$dir/setup-complete-v1"
  echo "setup $req" >> "$log"
  echo "Configured authority: ${AUTHORITY}" ;;
start|enable) echo "$op $*" >> "$log"; echo "backend: active" ;;
*) exit 3 ;;
esac
`;

export interface DeploymentFixture {
  readonly root: string;
  readonly home: string;
  readonly calls: DeploymentRemoteCommand[];
  readonly run: DeploymentRemoteRunner;
  readonly backendLog: () => Promise<string[]>;
  readonly graph: (version: string, options?: GraphOptions) => Promise<DeploymentGraphSource>;
  readonly cleanup: () => Promise<void>;
}
interface GraphOptions {
  readonly url?: "file" | "unreachable" | "none";
  readonly pin?: string;
}

/** A private local "remote" account: shims stand in for getent/curl, commands run locally. */
export async function makeDeploymentFixture(): Promise<DeploymentFixture> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "bb-deploy-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const hostKeys = join(root, "hostkeys");
  for (const dir of [home, bin, hostKeys]) await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(join(hostKeys, "ssh_host_ed25519_key.pub"), "ssh-ed25519 AAAAfixture host\n");
  const shims: Record<string, string> = {
    getent: `#!/bin/sh\nprintf 'dev:x:1000:1000::%s:/bin/sh\\n' '${home}'\n`,
    curl: `#!/bin/sh\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; --*=*|-*) case "$1" in --proto|--proto-redir|--max-redirs|--connect-timeout|--max-filesize) shift 2 ;; *) shift ;; esac ;; *) url=$1; shift ;; esac; done\ncase "$url" in file://*) cp "\${url#file://}" "$out" ;; *) exit 7 ;; esac\n`,
  };
  try {
    execFileSync("/bin/sh", ["-c", "command -v sha256sum"], { env: { PATH: "/usr/bin:/bin" } });
  } catch {
    shims.sha256sum = `#!/bin/sh\nexec shasum -a 256 "$@"\n`;
  }
  for (const [name, body] of Object.entries(shims))
    await fs.writeFile(join(bin, name), body, { mode: 0o700 });
  const calls: DeploymentRemoteCommand[] = [];
  const run: DeploymentRemoteRunner = async (_target, command, signal) => {
    calls.push(command);
    const args = command.args.map((arg) => (arg === SSH_HOST_KEY_DIR ? hostKeys : arg));
    return runBoundedProcess(
      command.command,
      args,
      // The fake "remote" runs locally, so the remote env becomes this process's env here only.
      { ...command, localEnv: { PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C", ...command.env } },
      signal,
    );
  };
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const graph = async (version: string, options: GraphOptions = {}) => {
    const tree = join(root, `graph-${version}`);
    const members: Array<readonly [string, string, boolean]> = [
      ["runtime/node", FAKE_NODE, true],
      ["server/bin.mjs", `// backend ${version}\n`, false],
      ["server/remote-client-relay/remoteBackendClientRelay.mjs", `// relay ${version}\n`, false],
    ];
    for (const [path, body, executable] of members) {
      await fs.mkdir(join(tree, path, ".."), { recursive: true, mode: 0o700 });
      await fs.writeFile(join(tree, path), body, { mode: executable ? 0o700 : 0o600 });
    }
    const archive = join(root, `graph-${version}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", tree, "runtime", "server"], {
      env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
    });
    const unsigned = {
      revision: 1 as const,
      version,
      buildDigest: "a".repeat(64),
      target: "aarch64-unknown-linux-gnu" as const,
      node: "runtime/node",
      entry: "server/bin.mjs",
      files: members.map(([path, body, executable]) => ({
        path,
        sizeBytes: Buffer.byteLength(body),
        sha256: sha(body),
        executable,
      })),
    };
    const payload = canonicalBackendGraphPayload({
      ...unsigned,
      files: unsigned.files.toSorted((a, b) => (a.path < b.path ? -1 : 1)),
      signature: { algorithm: "ed25519", keyId: "test-key", value: "" },
    });
    const raw = {
      ...unsigned,
      signature: {
        algorithm: "ed25519",
        keyId: "test-key",
        value: sign(null, payload, keys.privateKey).toString("base64"),
      },
    };
    const manifestJson = JSON.stringify(raw);
    const url = options.url ?? "file";
    return {
      origin: "local" as const,
      manifest: decodeBackendGraphManifest(raw),
      manifestJson,
      manifestSha256: sha(manifestJson),
      archiveSha256: options.pin ?? sha(await fs.readFile(archive)),
      ...(url === "none"
        ? {}
        : { archiveUrl: url === "file" ? `file://${archive}` : "https://unreachable.invalid/g" }),
      materializeArchive: async () => ({ path: archive, release: async () => {} }),
      trustedKeys: { "test-key": publicKey },
      rustManifestJson: '{"fixture":true}\n',
    };
  };
  return {
    root,
    home,
    calls,
    run,
    graph,
    backendLog: async () =>
      (await fs.readFile(join(home, ".fake-backend.log"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

export function memoryProfileStore(): DeploymentProfileStore & {
  readonly rows: RemoteBackendProfileRecord[];
} {
  const rows: RemoteBackendProfileRecord[] = [];
  return {
    rows,
    list: async () => rows,
    get: async (id) => rows.find((row) => row.profileId === id),
    findByRequestId: async (id) => rows.find((row) => row.requestId === id),
    findByTarget: async (target) => rows.find((row) => row.executionTargetId === target),
    insert: async (record) => {
      rows.push(record);
      return record;
    },
  };
}
