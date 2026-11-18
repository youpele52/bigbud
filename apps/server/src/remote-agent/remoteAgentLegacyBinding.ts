import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { parseRemoteAgentCheckOutput } from "./remoteAgentIdentity.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import {
  validateRemoteAgentRuntime,
  remoteAgentBuildId,
  remoteAgentRuntimeEqual,
} from "./remoteAgentRuntime.ts";
import { buildRemoteAgentRuntimeProbeCommand } from "./remoteAgentConnection.identity.ts";
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
  ) => RemoteAgentConnection | Promise<RemoteAgentConnection> = (runtime) =>
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
  externalBinaryPath?: string,
): Promise<RemoteAgentRuntimeBinding | undefined> {
  if (historical) verifyRemoteAgentArtifactSignature(historical.artifact, historical.trustStore);
  const output = await control.run(
    buildRemoteAgentRuntimeProbeCommand(externalBinaryPath ?? "$HOME/.bigbud/agent/bin/current"),
  );
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
    generation: externalBinaryPath ? `external-${sha256?.slice(0, 23)}` : "legacy",
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
  const connection = await connect(runtime);
  const timer = setTimeout(() => connection.close(), 30_000);
  try {
    const hello = await connection.handshake();
    assertRemoteAgentRuntimeHello(runtime, hello);
    if (
      externalBinaryPath &&
      !(["terminal.pty", "workspace.files", "terminal.shell-profiles"] as const).every((name) =>
        hello.capabilities.some((capability) => capability.name === name && capability.major === 1),
      )
    )
      throw new Error("External runtime does not support explicit shell profiles.");
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
      if (externalBinaryPath) {
        const existing = current.builds.find((entry) => entry.id === id);
        if (
          existing &&
          (!remoteAgentRuntimeEqual(existing.runtime, runtime) || existing.binary !== "present")
        )
          throw new Error(
            "External runtime descriptor changed; existing ownership requires recovery.",
          );
        const launch = current.launches.find((entry) => entry.id === runtime.generation);
        if (
          launch &&
          (launch.buildId !== id || launch.epoch !== hello.agentEpoch || launch.phase !== "ready")
        )
          throw new Error("External runtime epoch changed; existing ownership requires recovery.");
        return {
          ...current,
          revision: current.revision + 1,
          builds: existing
            ? current.builds
            : [
                ...current.builds,
                {
                  id,
                  runtime,
                  health: "staged" as const,
                  promotion: 0,
                  binary: "present" as const,
                  authenticated: false,
                },
              ],
          launches: launch
            ? current.launches
            : [
                ...current.launches,
                {
                  id: runtime.generation,
                  buildId: id,
                  phase: "ready" as const,
                  epoch: hello.agentEpoch,
                },
              ],
        };
      }
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
    if (externalBinaryPath) return { runtime, expectedEpoch: hello.agentEpoch };
    const selected = state.builds.find((entry) => entry.id === state.current)!;
    const launch = state.launches.find((entry) => entry.buildId === selected.id)!;
    return { runtime: selected.runtime, expectedEpoch: launch.epoch };
  } finally {
    clearTimeout(timer);
    connection.close();
  }
}
