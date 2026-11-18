/**
 * Graph source for remote runtime updates (M3 WP-4D). Resolution is WP-3A's
 * `makeDeploymentGraphSourceResolver` (signed release asset pinned by sha256, or a development
 * local graph), run on the backend host with the requested version as the release version. A
 * managed backend's environment is cleared, so `local-graph` updates take their directory, extra
 * keys and Rust install source from the owner-private dev inputs (`runtimeUpdate.devInputs.ts`). Extraction untars into the reserved archive slot, verifies the graph in
 * place with the pinned trust, and records the native receipt and graph pins next to the entry
 * while the original verification token still exists (activation needs them after a restart).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { serializeVerifiedBackendGraphReceipt } from "./backendGraph.receipt.ts";
import { verifyBackendGraph, type VerifiedBackendGraph } from "./backendGraph.ts";
import {
  LOCAL_GRAPH_DIR_ENV,
  RELEASE_GRAPH_VERSION_ENV,
  makeDeploymentGraphSourceResolver,
} from "./deployment.source.ts";
import type { DeploymentGraphSourceResolver } from "./deployment.types.ts";
import type { RemoteAgentInstallSource } from "../remote-agent/remoteAgentInstallManager.ts";
import { loadRemoteAgentInstallSource } from "../remote-agent/remoteAgentInstallSource.ts";
import type { RuntimeUpdateDevInputsReport } from "./runtimeUpdate.devInputs.ts";
import { writeStagedGraphPins } from "./runtimeUpdate.unit.ts";
import type { RuntimeUpdateGraphSource } from "./Services/RemoteRuntimeUpdate.ts";

type GraphTarget = Parameters<DeploymentGraphSourceResolver>[0];

export function runtimeUpdateGraphTarget(arch: string = process.arch): GraphTarget {
  if (arch === "x64") return "x86_64-unknown-linux-gnu";
  if (arch === "arm64") return "aarch64-unknown-linux-gnu";
  throw new Error(`Runtime updates are not available for ${arch} hosts.`);
}

/** Untars a materialized graph archive into an empty private directory. */
export async function extractGraphArchive(archive: string, graphRoot: string, signal: AbortSignal) {
  await fs.mkdir(graphRoot, { mode: 0o700 });
  await promisify(execFile)("tar", ["-xzf", archive, "-C", graphRoot, "--no-same-owner"], {
    signal,
    timeout: 10 * 60_000,
  });
}

/** Writes the native receipt and graph pins beside the slot while the original token exists. */
export async function recordStagedGraphPins(
  graphRoot: string,
  token: VerifiedBackendGraph,
  signal?: AbortSignal,
) {
  const receipt = await serializeVerifiedBackendGraphReceipt(token, signal);
  await writeStagedGraphPins(dirname(graphRoot), {
    raw: receipt.raw,
    receiptSha256: receipt.sha256,
    nodePath: receipt.nodePath,
    nodeSha256: receipt.nodeSha256,
    entryPath: receipt.entryPath,
    entrySha256: receipt.entrySha256,
  });
}

export function makeRuntimeUpdateGraphSource(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly loadRustSource: (signal: AbortSignal) => Promise<RemoteAgentInstallSource>;
  /** The owner-private dev inputs, read per request; absent outside a managed backend. */
  readonly devInputs?: () => Promise<RuntimeUpdateDevInputsReport>;
  readonly target?: GraphTarget;
}): RuntimeUpdateGraphSource {
  return {
    resolve: async ({ version, source }, signal) => {
      if (source === "laptop-upload")
        throw new Error("Laptop-uploaded runtime updates are not available yet.");
      const environment: NodeJS.ProcessEnv = { ...input.environment };
      let loadRustSource = input.loadRustSource;
      let localTrustedKeys: Readonly<Record<string, string>> = {};
      if (source === "release") {
        delete environment[LOCAL_GRAPH_DIR_ENV];
        environment[RELEASE_GRAPH_VERSION_ENV] = version;
      } else {
        const report = (await input.devInputs?.()) ?? { kind: "absent" as const };
        if (report.kind === "refused")
          throw new Error(`The development update inputs were refused: ${report.reason}.`);
        if (report.kind === "loaded") {
          const { graphVersionsDirectory, trustedKeys, installSourcePath } = report.value;
          // The contract's version pattern has no path separators, so this stays one level down.
          environment[LOCAL_GRAPH_DIR_ENV] = join(graphVersionsDirectory, version);
          localTrustedKeys = trustedKeys;
          if (installSourcePath)
            loadRustSource = (inner) =>
              loadRemoteAgentInstallSource(
                { BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH: installSourcePath },
                { signal: inner },
              );
        } else if (!environment[LOCAL_GRAPH_DIR_ENV]?.trim())
          throw new Error(
            "Local-graph updates need the backend's development update inputs: run `bigbud backend update-inputs set` on the backend host.",
          );
      }
      const target = input.target ?? runtimeUpdateGraphTarget();
      const resolved = await makeDeploymentGraphSourceResolver({
        environment,
        loadRustSource,
        localTrustedKeys,
      })(target, signal);
      if (resolved.manifest.version !== version)
        throw new Error("The resolved backend graph is not the requested version.");
      return {
        manifest: JSON.parse(resolved.manifestJson) as unknown,
        extract: async (graphRoot, inner) => {
          const archive = await resolved.materializeArchive(inner);
          try {
            await extractGraphArchive(archive.path, graphRoot, inner);
          } finally {
            await archive.release();
          }
          const token = await verifyBackendGraph({
            root: graphRoot,
            manifest: JSON.parse(resolved.manifestJson) as unknown,
            trustStore: resolved.trustedKeys,
            target,
            signal: inner,
          });
          await recordStagedGraphPins(graphRoot, token, inner);
          return token;
        },
      };
    },
  };
}
