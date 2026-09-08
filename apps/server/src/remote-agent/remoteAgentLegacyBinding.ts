import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { parseRemoteAgentCheckOutput } from "./remoteAgentIdentity.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import { validateRemoteAgentRuntime, remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import { assertRemoteAgentRuntimeHello } from "./remoteAgentCompatibility.ts";
import {
  verifyRemoteAgentArtifactSignature,
  type RemoteAgentArtifact,
  type RemoteAgentArtifactTrustStore,
} from "./remoteAgentArtifact.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";

/** Observe legacy continuity without preparing, relaunching, importing state, or granting artifact trust. */
export async function observeLegacyRemoteAgentBinding(
  target: string,
  control: RemoteAgentControl,
  connect: (
    runtime: import("./remoteAgentRuntime.ts").RemoteAgentRuntime,
  ) => RemoteAgentConnection = (runtime) =>
    RemoteAgentConnection.ssh({
      executionTargetId: target,
      runtime,
      binaryPath: runtime.binaryPath,
    }),
  historical:
    | {
        readonly artifact: RemoteAgentArtifact;
        readonly trustStore: RemoteAgentArtifactTrustStore;
      }
    | undefined = undefined,
): Promise<RemoteAgentRuntimeBinding | undefined> {
  if (historical) verifyRemoteAgentArtifactSignature(historical.artifact, historical.trustStore);
  const output = await control.run(`set -eu
binary="$HOME/.bigbud/agent/bin/current"
if test ! -x "$binary"; then printf missing; exit 0; fi
readlink -f -- "$binary"
sha256sum -- "$binary" | cut -d ' ' -f1
"$binary" --check
`);
  if (output.trim() === "missing") return undefined;
  const [binaryPath, sha256, ...checkLines] = output.trim().split("\n");
  const check = parseRemoteAgentCheckOutput(checkLines.join("\n"));
  if (check.protocolMajor !== 1 || check.operatingSystem !== "linux") {
    throw new Error("Unmanaged remote runtime needs an explicit compatible connection.");
  }
  const historicalIdentityMatches = historical
    ? historical.artifact.version === "0.2.205" &&
      (check.version === historical.artifact.version || check.version === "0.1.0") &&
      check.buildDigest === historical.artifact.buildDigest &&
      sha256 === historical.artifact.sha256 &&
      check.architecture ===
        (historical.artifact.targetTriple.startsWith("aarch64") ? "aarch64" : "x86_64")
    : false;
  const runtimeVersion = historicalIdentityMatches ? historical!.artifact.version : check.version;
  const statePath = `${control.root}/state`;
  const runtime = validateRemoteAgentRuntime({
    generation: "legacy",
    version: runtimeVersion,
    sha256,
    buildDigest: check.buildDigest,
    targetTriple: `${check.architecture}-unknown-linux-gnu`,
    binaryPath,
    statePath,
    socketPath: `${statePath}/supervisor.sock`,
    logPath: `${statePath}/supervisor.log`,
    origin: "legacy-external",
  });
  const connection = connect(runtime);
  const timer = setTimeout(() => connection.close(), 30_000);
  try {
    const hello = await connection.handshake();
    assertRemoteAgentRuntimeHello(runtime, hello);
    const readinessId = `legacy-readiness-${crypto.randomUUID()}`;
    const readiness = await connection.request(
      {
        type: "diagnosticRequest",
        value: {
          requestId: readinessId,
          operationId: readinessId,
          requestDigest: remoteAgentRequestDigest(readinessId),
          workspaceHandle: "",
          deadlineUnixMs: Date.now() + 30_000,
          kind: "readiness",
        },
      },
      (frame) => frame.type === "diagnosticResponse" && frame.value.requestId === readinessId,
    );
    if (
      readiness.type !== "diagnosticResponse" ||
      !readiness.value.accepted ||
      !readiness.value.terminal ||
      readiness.value.message !== "agent-ready"
    )
      throw new Error("Legacy remote runtime did not confirm readiness.");
    const id = remoteAgentBuildId(runtime);
    const state = await control.registry.update((current) => {
      if (current.current) return current;
      if (current.builds.some((entry) => entry.runtime.generation === "legacy"))
        throw new Error("Legacy continuity is already reserved; recovery is required.");
      return {
        ...current,
        revision: current.revision + 1,
        current: id,
        builds: [
          ...current.builds,
          {
            id,
            runtime,
            health: historicalIdentityMatches ? "healthy" : "staged",
            promotion: historicalIdentityMatches ? 1 : 0,
            binary: "present",
            authenticated: historicalIdentityMatches,
          },
        ],
        pins: [...current.pins, { owner: "unknown-legacy-owner", buildId: id }],
        launches: [
          ...current.launches,
          { id: "legacy", buildId: id, phase: "ready", epoch: hello.agentEpoch },
        ],
      };
    });
    const selected = state.builds.find((entry) => entry.id === state.current)!;
    const launch = state.launches.find((entry) => entry.buildId === selected.id)!;
    return { runtime: selected.runtime, expectedEpoch: launch.epoch };
  } finally {
    clearTimeout(timer);
    connection.close();
  }
}
