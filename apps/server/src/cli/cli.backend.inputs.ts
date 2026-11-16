import { createPublicKey } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { ownershipStateDir } from "@bigbud/shared/backendOwnership.paths";
import { hasRemoteAgentPathControls } from "../remote-agent/remoteAgentRuntime.ts";
import { within } from "../remote-backend/localSupervisorService.setup.validation.ts";
import { readLocalSupervisorServiceFile } from "../remote-backend/localSupervisorService.files.ts";
import { verifyBackendGraph } from "../remote-backend/backendGraph.ts";
import { decodeBackendGraphManifest } from "../remote-backend/backendGraph.manifest.ts";
import { parseRemoteAgentInstallSource } from "../remote-agent/remoteAgentInstallManager.ts";
import { verifyRemoteAgentArtifactSignature } from "@bigbud/shared/remoteAgentArtifact";

export interface BackendSetupCliInput {
  readonly graphRoot: string;
  readonly graphManifest: string;
  readonly rustManifest: string;
  readonly trustedKeys: string;
  readonly backendHome: string;
  readonly requestId: string;
  readonly confirmFreshSetup: boolean;
  readonly restart: "on-failure" | "never";
}
/** Refuse symlinked existing ancestors before the finite bootstrap creates anything. */
async function assertCanonicalUncreatedHome(path: string) {
  for (let current = path, depth = 0; depth < 128; current = dirname(current), depth++) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current)
        throw new Error("Backend home must have canonical directory ancestors.");
      return;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  throw new Error("Backend home exceeds the bounded path policy.");
}

/** Explicit local owner trust, never keys embedded in the downloaded manifest. */
export function decodeBackendSetupTrust(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A pinned public-key map is required.");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 32) throw new Error("Invalid public-key count.");
  return Object.freeze(
    Object.fromEntries(
      entries.map(([id, pem]) => {
        if (
          !/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
          typeof pem !== "string" ||
          pem.length > 4096 ||
          !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\r\n]+\n-----END PUBLIC KEY-----\s*$/.test(
            pem,
          )
        )
          throw new Error("Only pinned Ed25519 public keys are accepted.");
        const key = createPublicKey(pem);
        if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 public key required.");
        return [id, key.export({ type: "spki", format: "pem" }).toString()];
      }),
    ),
  );
}

/** All metadata is bounded/private and graph authentication precedes backend-state creation. */
export async function prepareBackendSetupCliInput(
  input: BackendSetupCliInput,
  signal: AbortSignal,
) {
  const fixed = Object.freeze({ ...input });
  if (
    fixed.confirmFreshSetup !== true ||
    (fixed.restart !== "on-failure" && fixed.restart !== "never") ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(fixed.requestId)
  )
    throw new Error("Explicit fresh setup and a stable request UUID are required.");
  signal.throwIfAborted();
  const graphRoot = resolve(fixed.graphRoot);
  const backendHome = resolve(fixed.backendHome);
  if ([graphRoot, backendHome].some((p) => p.length > 8192 || hasRemoteAgentPathControls(p)))
    throw new Error("Backend and executable paths must have an unambiguous bounded shape.");
  await assertCanonicalUncreatedHome(backendHome);
  const home = await realpath(userInfo().homedir);
  const mutable = [
    backendHome,
    ownershipStateDir(backendHome, false),
    join(home, ".bigbud/agent"),
    join(home, ".bigbud/backend-services"),
  ];
  if (mutable.some((p) => within(graphRoot, p) || within(p, graphRoot)))
    throw new Error("Backend mutable state and executable graph must be separate.");
  const paths = [fixed.graphManifest, fixed.rustManifest, fixed.trustedKeys].map((p) => resolve(p));
  if (paths.some((p) => within(graphRoot, p)))
    throw new Error("Signed metadata and pinned trust must be outside the executable graph.");
  const keys = decodeBackendSetupTrust(
    JSON.parse(await readLocalSupervisorServiceFile(paths[2]!, 64 * 1024)),
  );
  signal.throwIfAborted();
  const manifest = decodeBackendGraphManifest(
    JSON.parse(await readLocalSupervisorServiceFile(paths[0]!, 16 * 1024 * 1024)),
  );
  const target =
    process.arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : process.arch === "x64"
        ? "x86_64-unknown-linux-gnu"
        : null;
  if (!target || manifest.target !== target)
    throw new Error("Executable graph does not match this account architecture.");
  const graph = await verifyBackendGraph({
    root: graphRoot,
    manifest,
    trustStore: keys,
    target,
    signal,
  });
  const rustSource = parseRemoteAgentInstallSource({
    manifest: JSON.parse(await readLocalSupervisorServiceFile(paths[1]!, 1024 * 1024)),
    trustStore: keys,
  });
  for (const artifact of rustSource.manifest.artifacts)
    verifyRemoteAgentArtifactSignature(artifact, keys);
  signal.throwIfAborted();
  return Object.freeze({
    graph,
    rustSource,
    backendHome,
    requestId: fixed.requestId,
    confirmFreshSetup: true as const,
    restart: fixed.restart === "on-failure",
  });
}
