import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { authenticateBackendGraphManifest } from "./backendGraph.manifest.ts";
import { decodeBackendSetupTrust } from "../cli/cli.backend.inputs.ts";
import { downloadRemoteAgentHttp } from "../remote-agent/remoteAgentHttpDownload.ts";
import {
  REMOTE_AGENT_ARTIFACT_DOWNLOAD_POLICY,
  REMOTE_AGENT_METADATA_DOWNLOAD_POLICY,
} from "../remote-agent/remoteAgentHttpDownload.policy.ts";
import { DEFAULT_RELEASE_REPOSITORY } from "../remote-agent/remoteAgentInstallSource.ts";
import type { RemoteAgentInstallSource } from "../remote-agent/remoteAgentInstallManager.ts";
import {
  deploymentError,
  type DeploymentGraphSource,
  type DeploymentGraphSourceResolver,
} from "./deployment.types.ts";

/** Dev/test override: a local producer output directory (`bun run remote-backend-graph`). */
export const LOCAL_GRAPH_DIR_ENV = "BIGBUD_REMOTE_BACKEND_GRAPH_DIR";
/** Dev/test: JSON map of extra pinned Ed25519 PUBLIC keys (e.g. the producer's fixture key). */
export const LOCAL_GRAPH_KEYS_ENV = "BIGBUD_REMOTE_BACKEND_GRAPH_TRUSTED_KEYS";
/** Release graph version to deploy; graphs are signed release assets pinned by sha256 (D5). */
export const RELEASE_GRAPH_VERSION_ENV = "BIGBUD_REMOTE_BACKEND_GRAPH_VERSION";

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function authenticate(input: {
  readonly manifestJson: string;
  readonly target: Parameters<DeploymentGraphSourceResolver>[0];
  readonly rust: RemoteAgentInstallSource;
  readonly extraKeys: Readonly<Record<string, string>>;
}) {
  let trustedKeys: Readonly<Record<string, string>>;
  let manifest: DeploymentGraphSource["manifest"];
  try {
    trustedKeys = decodeBackendSetupTrust({ ...input.rust.trustStore, ...input.extraKeys });
    manifest = authenticateBackendGraphManifest(
      JSON.parse(input.manifestJson),
      trustedKeys,
      input.target,
    );
  } catch {
    throw deploymentError(
      "graph-unavailable",
      "The backend graph manifest failed signature or target verification.",
    );
  }
  return {
    manifest,
    trustedKeys,
    manifestJson: input.manifestJson,
    manifestSha256: sha256(input.manifestJson),
    rustManifestJson: JSON.stringify(input.rust.manifest),
  };
}

async function localSource(
  directory: string,
  keysPath: string | undefined,
  target: Parameters<DeploymentGraphSourceResolver>[0],
  rust: RemoteAgentInstallSource,
): Promise<DeploymentGraphSource> {
  const names = await readdir(directory);
  const archives = names.filter((name) => name.endsWith(`-${target}.tar.gz`));
  const manifests = names.filter(
    (name) => name === "manifest.json" || name.endsWith(`-${target}.manifest.json`),
  );
  if (archives.length !== 1 || manifests.length !== 1)
    throw deploymentError("graph-unavailable", `No single local ${target} backend graph found.`);
  const archive = join(directory, archives[0]!);
  const manifestJson = await readFile(join(directory, manifests[0]!), "utf8");
  const extraKeys: Record<string, string> = keysPath
    ? (JSON.parse(await readFile(keysPath, "utf8")) as Record<string, string>)
    : {};
  const fixture = names.find((name) => name.endsWith(`-${target}.fixture-public-key.pem`));
  const keyId = (JSON.parse(manifestJson) as { signature?: { keyId?: unknown } }).signature?.keyId;
  if (fixture && typeof keyId === "string" && !Object.hasOwn(extraKeys, keyId))
    extraKeys[keyId] = await readFile(join(directory, fixture), "utf8");
  const verified = authenticate({ manifestJson, target, rust, extraKeys });
  // Producer provenance pins the archive; without it the laptop pins the bytes it will upload.
  const provenance = names.includes("provenance.json")
    ? (JSON.parse(await readFile(join(directory, "provenance.json"), "utf8")) as {
        archive?: { name?: unknown; sha256?: unknown };
      })
    : undefined;
  const actual = await sha256File(archive);
  const recorded = provenance?.archive;
  const pinned =
    recorded && recorded.name === archives[0] && typeof recorded.sha256 === "string"
      ? recorded.sha256
      : actual;
  if (pinned !== actual)
    throw deploymentError("hash-mismatch", "The local backend graph archive differs from its pin.");
  return {
    origin: "local",
    ...verified,
    archiveSha256: pinned,
    materializeArchive: async () => ({ path: archive, release: async () => {} }),
  };
}

async function releaseSource(
  version: string,
  environment: NodeJS.ProcessEnv,
  target: Parameters<DeploymentGraphSourceResolver>[0],
  rust: RemoteAgentInstallSource,
  signal: AbortSignal,
): Promise<DeploymentGraphSource> {
  const repository =
    environment.BIGBUD_REMOTE_AGENT_RELEASE_REPOSITORY?.trim() || DEFAULT_RELEASE_REPOSITORY;
  if (!VERSION.test(version) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw deploymentError("graph-unavailable", "The backend graph release is misconfigured.");
  const prefix = `https://github.com/${repository}/releases/download/v${version}/bigbud-backend-graph-${version}-${target}`;
  const text = async (url: string, maxBytes: number) =>
    new TextDecoder().decode(
      await downloadRemoteAgentHttp({
        url,
        policy: { ...REMOTE_AGENT_METADATA_DOWNLOAD_POLICY, maxBytes },
        signal,
      }),
    );
  let manifestJson: string, pin: string | undefined;
  try {
    manifestJson = await text(`${prefix}.manifest.json`, 16 * 1024 * 1024);
    pin = /^([a-f0-9]{64})\s/.exec(await text(`${prefix}.tar.gz.sha256`, 4096))?.[1];
  } catch {
    throw deploymentError("graph-unavailable", `Backend graph release v${version} is unavailable.`);
  }
  if (!pin) throw deploymentError("graph-unavailable", "The backend graph pin is malformed.");
  const archiveSha256 = pin;
  return {
    origin: "release",
    ...authenticate({ manifestJson, target, rust, extraKeys: {} }),
    archiveSha256,
    archiveUrl: `${prefix}.tar.gz`,
    materializeArchive: async (inner) => {
      const bytes = await downloadRemoteAgentHttp({
        url: `${prefix}.tar.gz`,
        policy: { ...REMOTE_AGENT_ARTIFACT_DOWNLOAD_POLICY, maxBytes: 512 * 1024 * 1024 },
        signal: inner,
      });
      if (sha256(bytes) !== archiveSha256)
        throw deploymentError(
          "hash-mismatch",
          "The downloaded backend graph differs from its pin.",
        );
      const directory = await mkdtemp(join(tmpdir(), "bigbud-graph-"));
      const path = join(directory, "graph.tar.gz");
      await writeFile(path, bytes, { mode: 0o600 });
      return { path, release: () => rm(directory, { recursive: true, force: true }) };
    },
  };
}

/** Release asset by default; an explicit local graph directory only outside packaged desktop. */
export function makeDeploymentGraphSourceResolver(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly loadRustSource: (signal: AbortSignal) => Promise<RemoteAgentInstallSource>;
}): DeploymentGraphSourceResolver {
  return async (target, signal) => {
    const env = input.environment;
    const local = env[LOCAL_GRAPH_DIR_ENV]?.trim();
    const version = env[RELEASE_GRAPH_VERSION_ENV]?.trim();
    if (local && env.BIGBUD_DESKTOP_PACKAGED === "1")
      throw deploymentError("graph-unavailable", "Local backend graphs are a development option.");
    if (!local && !version)
      throw deploymentError(
        "graph-unavailable",
        `No backend graph release is configured. Set ${RELEASE_GRAPH_VERSION_ENV}, or ${LOCAL_GRAPH_DIR_ENV} in development.`,
      );
    let rust: RemoteAgentInstallSource;
    try {
      rust = await input.loadRustSource(signal);
    } catch {
      throw deploymentError("graph-unavailable", "The signed Rust runtime source is unavailable.");
    }
    if (local) {
      if (!(await stat(local).catch(() => undefined))?.isDirectory())
        throw deploymentError("graph-unavailable", "The local backend graph directory is missing.");
      return localSource(local, env[LOCAL_GRAPH_KEYS_ENV]?.trim() || undefined, target, rust);
    }
    return releaseSource(version!, env, target, rust, signal);
  };
}
