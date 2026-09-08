import { openRemoteAgentControl, type RemoteAgentControl } from "./remoteAgentControl.ts";
import { finishRemoteAgentAdmission } from "./remoteAgentAdmission.finish.ts";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import {
  pinRemoteAgentBuild,
  promoteRemoteAgentBuild,
  quarantineRemoteAgentBuild,
} from "./remoteAgentInstall.registry.transitions.ts";
import { MAX_REMOTE_AGENT_ADMISSION_RETIREMENTS } from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import { observeLegacyRemoteAgentBinding } from "./remoteAgentLegacyBinding.ts";
import { remoteAgentRuntimeSummary } from "./remoteAgentStatus.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import { remoteAgentOwners, type RemoteAgentConnectionBindings } from "./remoteAgentOwners.ts";
import {
  withRemoteAgentAdmissionGuard,
  RemoteAgentAdmissionRateLimitError,
} from "./remoteAgentAdmission.guard.ts";
import { releaseSupersededRemoteAgentConnection } from "./remoteAgentAdmission.references.ts";
import {
  RemoteAgentAdmissionError,
  nextRemoteAgentRegistryRevision,
} from "./remoteAgentAdmission.types.ts";
import { verifyRemoteAgentRuntimeAdmission } from "./remoteAgentAdmission.verify.ts";
import type { RemoteAgentArtifact, RemoteAgentArtifactTrustStore } from "./remoteAgentArtifact.ts";
import { markRemoteAgentUpdate } from "./remoteAgentUpdate.state.ts";

export { RemoteAgentAdmissionError } from "./remoteAgentAdmission.types.ts";

type ReadyRemoteAgentSelection = {
  readonly buildId: string;
  readonly epoch: string;
};

function readySelection(
  state: Awaited<ReturnType<RemoteAgentControl["registry"]["read"]>>,
  buildId: string | null,
): ReadyRemoteAgentSelection | undefined {
  if (!buildId) return undefined;
  const build = state.builds.find((entry) => entry.id === buildId);
  const launch = state.launches.find(
    (entry) => entry.buildId === buildId && entry.phase === "ready" && entry.epoch,
  );
  if (!build || !launch || build.binary !== "present" || build.health === "quarantined")
    return undefined;
  if (buildId === state.pending) {
    const update = state.updates.find(
      (entry) => entry.buildId === buildId && entry.phase === "ready-for-reconnect",
    );
    if (!update || update.epoch !== launch.epoch) return undefined;
  } else if (!build.authenticated || build.health !== "healthy") {
    return undefined;
  }
  return { buildId, epoch: launch.epoch };
}

function firstSelection(state: Awaited<ReturnType<RemoteAgentControl["registry"]["read"]>>): {
  readonly primary: string | null;
  readonly requestedBuildId?: string;
} {
  const pending = readySelection(state, state.pending);
  if (pending && pending.buildId !== state.current)
    return { primary: pending.buildId, requestedBuildId: pending.buildId };
  if (readySelection(state, state.current)) return { primary: state.current };
  if (readySelection(state, state.predecessor)) return { primary: state.predecessor };
  return { primary: null };
}

export function makeRemoteAgentAdmission(
  dependencies: {
    readonly bindings?: RemoteAgentConnectionBindings;
    readonly control?: (target: string) => Promise<RemoteAgentControl>;
    readonly connect?: (target: string, runtime: RemoteAgentRuntime) => RemoteAgentConnection;
    readonly historicalLegacy?: {
      readonly artifact: RemoteAgentArtifact;
      readonly trustStore: RemoteAgentArtifactTrustStore;
    };
  } = {},
) {
  const controlFor = dependencies.control ?? openRemoteAgentControl;
  const bindings: RemoteAgentConnectionBindings = dependencies.bindings ?? {
    getBinding: (target) => remoteAgentOwners().getBinding(target),
    bindConnection: (target, connectionId, binding) =>
      remoteAgentOwners().bindConnection(target, connectionId, binding),
    hasDurableReferences: (target, connectionId) => {
      const check = remoteAgentOwners().hasDurableReferences;
      return check
        ? check(target, connectionId)
        : Promise.reject(new Error("Durable connection references are unavailable."));
    },
    listConnectionIds: (target) =>
      remoteAgentOwners().listConnectionIds?.(target) ?? Promise.resolve([]),
  };
  const connect =
    dependencies.connect ??
    ((executionTargetId, runtime) =>
      RemoteAgentConnection.ssh({ executionTargetId, runtime, binaryPath: runtime.binaryPath }));

  const verify = (target: string, runtime: RemoteAgentRuntime, expectedEpoch?: string) =>
    verifyRemoteAgentRuntimeAdmission({
      target,
      runtime,
      connect,
      ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
    });

  const api = {
    status: async (target: string) => {
      const state = await (await controlFor(target)).registry.read();
      const local = await bindings.getBinding(target);
      return remoteAgentRuntimeSummary(
        local
          ? {
              ...state,
              current: remoteAgentBuildId(local.runtime),
              currentConnectionId: local.connectionId ?? null,
            }
          : state,
      );
    },
    resolveBinding: async (target: string): Promise<RemoteAgentRuntimeBinding | undefined> => {
      const local = await bindings.getBinding(target);
      if (local) return local;
      const control = await controlFor(target);
      const state = await control.registry.read();
      if (!state.current) {
        const observed = await observeLegacyRemoteAgentBinding(
          target,
          control,
          (runtime) => connect(target, runtime),
          dependencies.historicalLegacy,
        );
        if (observed)
          await bindings.bindConnection(
            target,
            observed.connectionId ?? observed.runtime.generation,
            observed,
          );
        return observed;
      }
      const build = state.builds.find((entry) => entry.id === state.current);
      const launch = state.launches.find(
        (entry) => entry.buildId === state.current && entry.phase === "ready",
      );
      if (!build || !launch?.epoch)
        throw new RemoteAgentAdmissionError(
          "CONTINUITY_UNKNOWN",
          "Current remote runtime requires recovery.",
        );
      const binding = {
        runtime: build.runtime,
        expectedEpoch: launch.epoch,
        connectionId: state.currentConnectionId ?? build.runtime.generation,
      };
      await bindings.bindConnection(target, binding.connectionId, binding);
      return binding;
    },
    admitFresh: async (target: string, requestId: string) => {
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(requestId))
        throw new Error("Invalid fresh connection identity.");
      const control = await controlFor(target);
      let state = await control.registry.read();
      const retired = state.admissionRetirements?.find((entry) => entry.id === requestId);
      if (retired)
        throw new RemoteAgentAdmissionError(
          "ADMISSION_RETIRED",
          `Connection request ${requestId} was already resolved as ${retired.outcome}; retrying it cannot select another runtime.`,
        );
      const prior = state.admissions.find((entry) => entry.id === requestId);
      if (prior?.phase === "ready") {
        const bound = state.builds.find((build) => build.id === prior.buildId);
        if (!bound || bound.binary !== "present" || bound.health === "quarantined")
          throw new RemoteAgentAdmissionError(
            "CONTINUITY_UNKNOWN",
            "The original connection is unavailable; its work was not moved.",
          );
        await verify(target, bound.runtime, prior.epoch);
        await bindings.bindConnection(target, requestId, {
          runtime: bound.runtime,
          expectedEpoch: prior.epoch,
          connectionId: requestId,
        });
        return finishRemoteAgentAdmission(control, requestId, bound.runtime);
      }
      if (
        !prior &&
        (state.admissionRetirements?.length ?? 0) >= MAX_REMOTE_AGENT_ADMISSION_RETIREMENTS
      )
        throw new RemoteAgentAdmissionError(
          "ADMISSION_HISTORY_FULL",
          "Remote connection history is full; no new connection can be admitted until it is safely recovered.",
        );

      // Selection is durable before the readiness recheck. A retry of the same
      // request can only revisit this build or its already-recorded fallback;
      // it may never observe a newer pending build and silently migrate.
      if (!prior) {
        const planned = firstSelection(state);
        if (!planned.primary)
          throw new RemoteAgentAdmissionError(
            "ADMISSION_UNAVAILABLE",
            "No ready remote runtime is available. Existing work remains pinned.",
          );
        state = await control.registry.update((current) => {
          const existing = current.admissions.find((entry) => entry.id === requestId);
          if (existing) return current;
          const selected =
            readySelection(current, planned.primary) ??
            readySelection(current, current.current) ??
            readySelection(current, current.predecessor);
          if (!selected)
            throw new RemoteAgentAdmissionError(
              "ADMISSION_UNAVAILABLE",
              "No ready remote runtime is available. Existing work remains pinned.",
            );
          return nextRemoteAgentRegistryRevision(current, {
            admissions: [
              ...current.admissions.filter((entry) => entry.id !== requestId),
              {
                id: requestId,
                buildId: selected.buildId,
                phase: "prepared",
                epoch: "",
                ...(planned.requestedBuildId ? { requestedBuildId: planned.requestedBuildId } : {}),
              },
            ],
          });
        });
      }

      state = await control.registry.read();
      const prepared = state.admissions.find((entry) => entry.id === requestId);
      if (!prepared || prepared.phase !== "prepared")
        throw new RemoteAgentAdmissionError(
          "ADMISSION_CONFLICT",
          "This fresh connection changed concurrently; retry the same request.",
        );
      const fallbackIds = prior
        ? []
        : [state.current, state.predecessor].filter(
            (id): id is string => id !== null && id !== prepared.buildId,
          );
      const choices = [prepared.buildId, ...fallbackIds];
      const failures: string[] = [];
      let failureCode: string | undefined;
      for (const buildId of choices) {
        state = await control.registry.read();
        const preparedNow = state.admissions.find((entry) => entry.id === requestId);
        if (!preparedNow || preparedNow.phase !== "prepared")
          throw new RemoteAgentAdmissionError(
            "ADMISSION_CONFLICT",
            "This fresh connection changed concurrently; retry the same request.",
          );
        if (buildId !== preparedNow.buildId && buildId !== prepared.buildId) continue;
        const build = state.builds.find((entry) => entry.id === buildId);
        const selected = readySelection(state, buildId);
        if (!build || !selected) {
          failures.push(`${build?.runtime.version ?? buildId}: NOT_READY`);
          continue;
        }
        let committed = false;
        try {
          await control.registry.update((current) =>
            pinRemoteAgentBuild(
              current,
              `activation:${requestId}:${build.runtime.generation}`,
              buildId,
            ),
          );
          // The launch epoch is the pin. Do not repair or launch here: health
          // preparation owns candidate startup, while fresh admission only
          // rechecks the exact ready runtime immediately before promotion.
          const epoch = await verify(target, build.runtime, selected.epoch);
          const commitState = await control.registry.read();
          const commitAdmission = commitState.admissions.find((entry) => entry.id === requestId);
          const commitLaunch = commitState.launches.find(
            (entry) => entry.buildId === buildId && entry.phase === "ready",
          );
          if (
            !commitAdmission ||
            commitAdmission.phase !== "prepared" ||
            commitAdmission.buildId !== buildId ||
            !commitLaunch ||
            commitLaunch.epoch !== selected.epoch ||
            epoch !== selected.epoch
          )
            throw new RemoteAgentAdmissionError(
              "ADMISSION_CONFLICT",
              "This fresh connection changed concurrently; retry the same request.",
            );
          await control.registry.update((current) =>
            pinRemoteAgentBuild(current, `connection:${requestId}`, buildId),
          );
          const previousConnectionId = commitState.currentConnectionId;
          state = await control.registry.update((current) => {
            const admission = current.admissions.find((entry) => entry.id === requestId);
            if (admission?.phase !== "prepared" || admission.buildId !== buildId)
              throw new RemoteAgentAdmissionError(
                "ADMISSION_CONFLICT",
                "Admission changed concurrently.",
              );
            return promoteRemoteAgentBuild(current, buildId, {
              id: requestId,
              epoch,
              ...(admission.requestedBuildId
                ? { requestedBuildId: admission.requestedBuildId }
                : {}),
              ...(failureCode ? { failureCode } : {}),
            });
          });
          committed = true;
          await bindings.bindConnection(target, requestId, {
            runtime: build.runtime,
            expectedEpoch: epoch,
            connectionId: requestId,
          });
          await releaseSupersededRemoteAgentConnection({
            bindings,
            control,
            target,
            previousConnectionId: previousConnectionId ?? undefined,
            currentConnectionId: requestId,
          });
          return await finishRemoteAgentAdmission(control, requestId, build.runtime);
        } catch (cause) {
          if (committed)
            throw new RemoteAgentAdmissionError(
              "BINDING_UNAVAILABLE",
              `Remote readiness was committed but local connection persistence failed (${cause instanceof Error ? cause.message : String(cause)}). Retry this connection request; no work was admitted.`,
            );
          failures.push(
            `${build.runtime.version}: ${cause instanceof RemoteAgentAdmissionError ? cause.code : "UNREACHABLE"}`,
          );
          failureCode = cause instanceof RemoteAgentAdmissionError ? cause.code : "UNREACHABLE";
          if (cause instanceof RemoteAgentAdmissionError && cause.buildFailure) {
            await control.registry.update((current) =>
              markRemoteAgentUpdate(quarantineRemoteAgentBuild(current, buildId), {
                requestId:
                  current.updates.find((entry) => entry.buildId === buildId)?.requestId ??
                  requestId,
                buildId,
                phase: "failed",
                outcome: "failed",
              }),
            );
          }

          const nextBuildId = state.current === buildId ? state.predecessor : state.current;
          const fallback = readySelection(await control.registry.read(), nextBuildId);
          if (fallback && fallback.buildId !== prepared.buildId) {
            await control.registry.update((current) => {
              const admission = current.admissions.find((entry) => entry.id === requestId);
              if (!admission || admission.phase !== "prepared") return current;
              return nextRemoteAgentRegistryRevision(current, {
                admissions: current.admissions.map((entry) =>
                  entry.id === requestId
                    ? {
                        ...entry,
                        buildId: fallback.buildId,
                        epoch: "",
                        requestedBuildId: entry.requestedBuildId ?? buildId,
                        failureCode,
                      }
                    : entry,
                ),
              });
            });
          }
        }
      }
      throw new RemoteAgentAdmissionError(
        "ADMISSION_UNAVAILABLE",
        `${failures.length ? failures.join("; ") : "No verified remote runtime is available"}. Existing work remains pinned.`,
      );
    },
  };
  return {
    status: api.status,
    resolveBinding: api.resolveBinding,
    fresh: (target: string, requestId: string) => {
      if (requestId.length > 64)
        throw new RemoteAgentAdmissionRateLimitError("Invalid fresh connection identity.");
      return withRemoteAgentAdmissionGuard(target, requestId, () =>
        api.admitFresh(target, requestId),
      );
    },
  };
}

export const remoteAgentAdmission = makeRemoteAgentAdmission();
