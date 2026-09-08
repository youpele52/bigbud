import { RemoteAgentConnection, RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import {
  RemoteAgentAdmissionError,
  nextRemoteAgentRegistryRevision,
} from "./remoteAgentAdmission.types.ts";
import { RemoteAgentStageDefinitiveError } from "./remoteAgentInstall.stage.ts";
import { markRemoteAgentUpdate } from "./remoteAgentUpdate.state.ts";
import { buildIsolatedRemoteAgentLaunch } from "./remoteAgentRuntime.launch.ts";
import { verifyRemoteAgentRuntimeHealth } from "./remoteAgentRuntime.health.ts";
import { remoteAgentBuildId, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentInstallSource } from "./remoteAgentInstallManager.ts";
import type { RemoteAgentArtifact } from "./remoteAgentArtifact.ts";

export class RemoteAgentUpdateDefinitiveError extends Error {
  readonly _tag = "RemoteAgentUpdateDefinitiveError";
}

export class RemoteAgentUpdateUncertainError extends Error {
  readonly _tag = "RemoteAgentUpdateUncertainError";
}

export interface RemoteAgentPreparationResult {
  readonly status: "ready-for-reconnect";
  readonly requestId: string;
  readonly buildId: string;
  readonly identity: RemoteAgentArtifact;
  readonly epoch: string;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildRemoteAgentCandidateStartupWaitCommand(runtime: RemoteAgentRuntime): string {
  const state = quote(runtime.statePath);
  return `set -eu\nstate=${state}\nfor n in $(seq 1 300); do\n  if test -f "$state/launch.exit" && test ! -L "$state/launch.exit"; then\n    printf 'startup-exit:'\n    cat "$state/launch.exit"\n    exit 0\n  fi\n  if test -S "$state/supervisor.sock"; then printf ready; exit 0; fi\n  sleep .1\ndone\nprintf unavailable\n`;
}

export function buildRemoteAgentCandidateExitWaitCommand(runtime: RemoteAgentRuntime): string {
  const state = quote(runtime.statePath);
  const socket = quote(runtime.socketPath);
  return `set -eu\nstate=${state}\nsocket=${socket}\nfor n in $(seq 1 300); do\n  if test ! -S "$socket" && test -f "$state/launch.exit" && test ! -L "$state/launch.exit"; then printf exited; exit 0; fi\n  sleep .1\ndone\nprintf unavailable\n`;
}

function buildIdForArtifact(artifact: RemoteAgentArtifact): string {
  return `${artifact.version}:${artifact.sha256}:${artifact.targetTriple}`;
}

function candidateRuntime(
  state: Awaited<ReturnType<RemoteAgentControl["registry"]["read"]>>,
  buildId: string,
): RemoteAgentRuntime {
  const build = state.builds.find((entry) => entry.id === buildId);
  if (!build) throw new RemoteAgentUpdateUncertainError("Candidate registry identity is missing.");
  if (build.binary !== "present") {
    throw new RemoteAgentUpdateUncertainError("Candidate bytes are not durably present.");
  }
  if (build.health === "quarantined") {
    throw new RemoteAgentUpdateDefinitiveError("Candidate is quarantined and cannot be reused.");
  }
  return build.runtime;
}

async function ensureCandidateLaunch(input: {
  readonly control: RemoteAgentControl;
  readonly runtime: RemoteAgentRuntime;
  readonly requestId: string;
}): Promise<void> {
  let state = await input.control.registry.read();
  let launch = state.launches.find((entry) => entry.buildId === remoteAgentBuildId(input.runtime));
  if (launch?.phase === "ready") return;
  if (launch?.phase === "proven-dead") {
    throw new RemoteAgentUpdateUncertainError("Candidate supervisor is no longer running.");
  }

  let ownsReservation = false;
  state = await input.control.registry.update((current) => {
    const existing = current.launches.find(
      (entry) => entry.buildId === remoteAgentBuildId(input.runtime),
    );
    if (existing) return current;
    ownsReservation = true;
    return nextRemoteAgentRegistryRevision(current, {
      launches: [
        ...current.launches,
        {
          id: input.runtime.generation,
          attemptId: input.requestId,
          buildId: remoteAgentBuildId(input.runtime),
          phase: "spawn-uncertain" as const,
          epoch: "",
        },
      ],
    });
  });
  launch = state.launches.find((entry) => entry.buildId === remoteAgentBuildId(input.runtime));
  if (!launch)
    throw new RemoteAgentUpdateUncertainError("Candidate launch reservation is missing.");
  if (ownsReservation) {
    let output: string;
    try {
      output = (
        await input.control.run(
          buildIsolatedRemoteAgentLaunch(input.runtime, launch.attemptId ?? input.requestId),
        )
      ).trim();
    } catch (cause) {
      throw new RemoteAgentUpdateUncertainError(
        `Candidate launch could not be confirmed (${cause instanceof Error ? cause.message : String(cause)}).`,
      );
    }
    if (output !== "launch-reserved" && output !== "launch-uncertain") {
      throw new RemoteAgentUpdateUncertainError("Candidate launch reservation is uncertain.");
    }
  }
  let startup: string;
  try {
    startup = (
      await input.control.run(buildRemoteAgentCandidateStartupWaitCommand(input.runtime))
    ).trim();
  } catch (cause) {
    throw new RemoteAgentUpdateUncertainError(
      `Candidate startup could not be verified (${cause instanceof Error ? cause.message : String(cause)}).`,
    );
  }
  if (startup === "ready") return;
  if (startup.startsWith("startup-exit:")) {
    throw new RemoteAgentUpdateDefinitiveError("Candidate supervisor exited before readiness.");
  }
  throw new RemoteAgentUpdateUncertainError("Candidate supervisor did not establish readiness.");
}

async function markChecking(input: {
  readonly control: RemoteAgentControl;
  readonly requestId: string;
  readonly buildId: string;
  readonly artifact: RemoteAgentArtifact;
}): Promise<void> {
  const state = await input.control.registry.read();
  const predecessor = state.current ?? state.predecessor ?? undefined;
  await input.control.registry.update((current) =>
    markRemoteAgentUpdate(current, {
      requestId: input.requestId,
      buildId: input.buildId,
      phase: "checking",
      identity: {
        version: input.artifact.version,
        sha256: input.artifact.sha256,
        buildDigest: input.artifact.buildDigest,
        targetTriple: input.artifact.targetTriple,
      },
      ...(predecessor ? { predecessorBuildId: predecessor } : {}),
    }),
  );
}

export function isDefinitiveRemoteAgentUpdateFailure(cause: unknown): boolean {
  return (
    cause instanceof RemoteAgentUpdateDefinitiveError ||
    cause instanceof RemoteAgentStageDefinitiveError ||
    (cause instanceof RemoteAgentAdmissionError && cause.buildFailure) ||
    (cause instanceof RemoteAgentConnectionError &&
      ["UNSUPPORTED_PROTOCOL_MAJOR", "IDENTITY_MISMATCH"].includes(cause.code ?? ""))
  );
}

export async function prepareRemoteAgentCandidate(input: {
  readonly target: string;
  readonly requestId: string;
  readonly artifact: RemoteAgentArtifact;
  readonly source: RemoteAgentInstallSource;
  readonly control: RemoteAgentControl;
  readonly install: (input: {
    readonly executionTargetId: string;
    readonly source: RemoteAgentInstallSource;
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly artifact: RemoteAgentArtifact }>;
  readonly connect?: (target: string, runtime: RemoteAgentRuntime) => RemoteAgentConnection;
  readonly signal?: AbortSignal;
}): Promise<RemoteAgentPreparationResult> {
  let state = await input.control.registry.read();
  let buildId = buildIdForArtifact(input.artifact);
  let build = state.builds.find((entry) => entry.id === buildId);
  if (build?.binary === "deleting") {
    throw new RemoteAgentUpdateUncertainError("Candidate retirement is still in progress.");
  }
  const priorUpdate = state.updates.find((entry) => entry.requestId === input.requestId);
  if (priorUpdate?.phase === "ready-for-reconnect" && build?.binary === "present") {
    return {
      status: "ready-for-reconnect",
      requestId: input.requestId,
      buildId,
      identity: input.artifact,
      epoch: priorUpdate.epoch ?? "",
    };
  }

  if (!build || build.binary !== "present" || build.health === "quarantined") {
    const result = await input.install({
      executionTargetId: input.target,
      source: input.source,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    buildId = buildIdForArtifact(result.artifact);
    state = await input.control.registry.read();
    build = state.builds.find((entry) => entry.id === buildId);
  }
  if (!build) throw new RemoteAgentUpdateUncertainError("Installed candidate was not published.");
  await markChecking({
    control: input.control,
    requestId: input.requestId,
    buildId,
    artifact: input.artifact,
  });
  const runtime = candidateRuntime(await input.control.registry.read(), buildId);
  await ensureCandidateLaunch({
    control: input.control,
    runtime,
    requestId: input.requestId,
  });
  const epoch = await verifyRemoteAgentRuntimeHealth({
    target: input.target,
    runtime,
    connect:
      input.connect ??
      ((target, candidate) =>
        RemoteAgentConnection.ssh({
          executionTargetId: target,
          runtime: candidate,
          binaryPath: candidate.binaryPath,
        })),
  });
  await input.control.registry.update((current) => {
    const launch = current.launches.find((entry) => entry.buildId === buildId);
    if (!launch || launch.phase === "proven-dead")
      throw new RemoteAgentUpdateUncertainError("Candidate launch changed during health checking.");
    return markRemoteAgentUpdate(
      nextRemoteAgentRegistryRevision(current, {
        launches: current.launches.map((entry) =>
          entry.buildId === buildId ? { ...entry, phase: "ready" as const, epoch } : entry,
        ),
      }),
      {
        requestId: input.requestId,
        buildId,
        phase: "ready-for-reconnect",
        outcome: "ready",
        epoch,
        identity: {
          version: input.artifact.version,
          sha256: input.artifact.sha256,
          buildDigest: input.artifact.buildDigest,
          targetTriple: input.artifact.targetTriple,
        },
      },
    );
  });
  return {
    status: "ready-for-reconnect",
    requestId: input.requestId,
    buildId,
    identity: input.artifact,
    epoch,
  };
}
