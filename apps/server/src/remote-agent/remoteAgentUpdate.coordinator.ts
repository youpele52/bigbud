import { Effect, Scope, ServiceMap } from "effect";

import { assertSshExecutionTargetReady } from "../ssh/sshVerification.ts";
import { openRemoteAgentControl, type RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type {
  RemoteAgentInstallSource,
  RemoteAgentResolvedArtifact,
} from "./remoteAgentInstallManager.ts";
import type { RemoteAgentArtifact } from "./remoteAgentArtifact.ts";
import { RemoteAgentCapacityUnavailableError } from "./remoteAgentInstall.stage.ts";
import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";
import {
  makeRemoteAgentInstallSourceLoader,
  type RemoteAgentInstallSourceLoader,
} from "./remoteAgentInstallSource.ts";
import { buildRemoteAgentSupervisorShutdownCommand } from "./remoteAgentSupervisor.ts";
import { reconcileRemoteAgentLaunchExits } from "./remoteAgentInstall.reconcile.ts";
import { quarantineRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import { markRemoteAgentUpdate } from "./remoteAgentUpdate.state.ts";
import {
  isDefinitiveRemoteAgentUpdateFailure,
  buildRemoteAgentCandidateExitWaitCommand,
  prepareRemoteAgentCandidate,
} from "./remoteAgentUpdate.prepare.ts";
import {
  makeRemoteAgentUpdateScheduler,
  type RemoteAgentUpdateScheduleItem,
  type RemoteAgentUpdateScheduler,
  type RemoteAgentUpdateTrigger,
} from "./remoteAgentUpdate.scheduler.ts";
import { registerRemoteAgentUpdateTrigger } from "./remoteAgentInstall.maintenance.ts";
import { remoteAgentOwners } from "./remoteAgentOwners.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { emptyRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { statusFromState, type RemoteAgentUpdateStatus } from "./remoteAgentUpdate.status.ts";

export interface RemoteAgentUpdateCoordinatorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly enqueue: (input: {
    readonly target: string;
    readonly trigger: RemoteAgentUpdateTrigger;
    readonly authenticated?: boolean;
  }) => void;
  readonly retry: (target: string) => void;
  readonly sourceChanged: () => Promise<void>;
  readonly getStatus: (
    target: string,
    reconnectRequestId?: string,
  ) => Promise<RemoteAgentUpdateStatus>;
  readonly drain: () => Promise<void>;
}

export class RemoteAgentUpdateCoordinator extends ServiceMap.Service<
  RemoteAgentUpdateCoordinator,
  RemoteAgentUpdateCoordinatorShape
>()("bigbud/remote-agent/RemoteAgentUpdateCoordinator") {}

export interface RemoteAgentUpdateCoordinatorDependencies {
  readonly installManager?: {
    readonly resolveArtifact: ReturnType<typeof makeRemoteAgentInstallManager>["resolveArtifact"];
    readonly install: (input: {
      readonly executionTargetId: string;
      readonly source: RemoteAgentInstallSource;
      readonly signal?: AbortSignal;
    }) => Promise<{ readonly artifact: RemoteAgentArtifact }>;
    readonly cleanup?: (target: string) => Promise<unknown>;
  };
  readonly loadInstallSource?: RemoteAgentInstallSourceLoader;
  readonly openControl?: (target: string) => Promise<RemoteAgentControl>;
  readonly knownTargets?: () => Promise<ReadonlyArray<string>>;
  readonly hasReusableCredentials?: (target: string) => boolean;
  readonly connect?: (target: string, runtime: RemoteAgentRuntime) => RemoteAgentConnection;
  readonly logger?: (cause: unknown, target?: string) => void;
  readonly scheduler?: RemoteAgentUpdateScheduler;
}

function sourceLoader(): RemoteAgentInstallSourceLoader {
  return makeRemoteAgentInstallSourceLoader();
}

function versionParts(version: string): ReadonlyArray<number> {
  return version.match(/\d+/g)?.map((part) => Number(part)) ?? [];
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}

function sameArtifactIdentity(
  runtime: Pick<RemoteAgentRuntime, "version" | "sha256" | "buildDigest" | "targetTriple">,
  artifact: RemoteAgentArtifact,
): boolean {
  return (
    runtime.version === artifact.version &&
    runtime.sha256 === artifact.sha256 &&
    runtime.buildDigest === artifact.buildDigest &&
    runtime.targetTriple === artifact.targetTriple
  );
}

function updateForArtifact(
  state: RemoteAgentRegistry,
  artifact: RemoteAgentResolvedArtifact["artifact"],
) {
  const requestId = `update-${artifact.sha256}`;
  return { requestId, update: state.updates.find((entry) => entry.requestId === requestId) };
}

function markUpdateFailure(
  state: RemoteAgentRegistry,
  requestId: string,
  buildId: string,
  artifact: RemoteAgentArtifact,
  cause: unknown,
): RemoteAgentRegistry {
  const prior = state.updates.find((entry) => entry.requestId === requestId);
  return markRemoteAgentUpdate(state, {
    requestId,
    buildId,
    phase: isDefinitiveRemoteAgentUpdateFailure(cause) ? "failed" : "uncertain",
    outcome: isDefinitiveRemoteAgentUpdateFailure(cause) ? "failed" : "uncertain",
    identity: {
      version: artifact.version,
      sha256: artifact.sha256,
      buildDigest: artifact.buildDigest,
      targetTriple: artifact.targetTriple,
    },
    ...(prior?.epoch ? { epoch: prior.epoch } : {}),
  });
}

function isReusableTarget(target: string, check: (target: string) => boolean): boolean {
  try {
    return check(target);
  } catch {
    return false;
  }
}

function defaultTargetList(): Promise<ReadonlyArray<string>> {
  try {
    return remoteAgentOwners().knownTargets?.() ?? Promise.resolve([]);
  } catch {
    return Promise.resolve([]);
  }
}

async function bestEffortFailedCandidateCleanup(
  target: string,
  control: RemoteAgentControl,
  manager: NonNullable<RemoteAgentUpdateCoordinatorDependencies["installManager"]>,
  buildId: string,
): Promise<void> {
  let state = await control.registry.read();
  const build = state.builds.find((entry) => entry.id === buildId);
  if (!build) return;
  await control.registry.update((current) => quarantineRemoteAgentBuild(current, buildId));
  const launch = state.launches.find((entry) => entry.buildId === buildId);
  if (launch && launch.phase !== "proven-dead") {
    try {
      const result = await control.run(buildRemoteAgentSupervisorShutdownCommand(build.runtime));
      if (result.trim() === "shutdown-accepted") {
        const exited = await control.run(buildRemoteAgentCandidateExitWaitCommand(build.runtime));
        if (exited.trim() === "exited") await reconcileRemoteAgentLaunchExits(control);
      }
    } catch {
      return;
    }
  }
  state = await control.registry.read();
  if (state.launches.some((entry) => entry.buildId === buildId && entry.phase !== "proven-dead"))
    return;
  await control.registry.update((current) => quarantineRemoteAgentBuild(current, buildId));
  if (manager.cleanup) await manager.cleanup(target).catch(() => undefined);
}

export function makeRemoteAgentUpdateCoordinator(
  dependencies: RemoteAgentUpdateCoordinatorDependencies = {},
): RemoteAgentUpdateCoordinatorShape {
  const manager = dependencies.installManager ?? makeRemoteAgentInstallManager();
  const loadSource = dependencies.loadInstallSource ?? sourceLoader();
  const openControl = dependencies.openControl ?? openRemoteAgentControl;
  const hasReusableCredentials =
    dependencies.hasReusableCredentials ??
    ((target) => {
      assertSshExecutionTargetReady(target);
      return true;
    });
  const logger =
    dependencies.logger ??
    ((cause, target) => {
      void Effect.runPromise(
        Effect.logWarning("remote agent update preparation failed", {
          target,
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    });
  let scheduler: RemoteAgentUpdateScheduler;
  const rootInFlight = new Map<string, Promise<void>>();
  const rootByTarget = new Map<string, string>();
  const stateByRoot = new Map<string, RemoteAgentRegistry>();
  let sourceChangeInFlight: Promise<void> | undefined;

  const prepare = async (target: string, item: RemoteAgentUpdateScheduleItem): Promise<void> => {
    if (
      !item.triggers.has("authenticated") &&
      !item.forceRetry &&
      !isReusableTarget(target, hasReusableCredentials)
    )
      return;
    const control = await openControl(target);
    rootByTarget.set(target, control.root);
    const existing = rootInFlight.get(control.root);
    if (existing) return existing;
    let resolvedArtifact: RemoteAgentArtifact | undefined;
    let requestId: string | undefined;
    let buildId: string | undefined;
    const task = (async () => {
      const source: RemoteAgentInstallSource = await loadSource();
      const resolved = await manager.resolveArtifact({
        executionTargetId: target,
        source,
        verifySignature: true,
      });
      resolvedArtifact = resolved.artifact;
      const state = await control.registry.read();
      stateByRoot.set(control.root, state);
      const identity = updateForArtifact(state, resolved.artifact);
      requestId = identity.requestId;
      buildId = [
        resolved.artifact.version,
        resolved.artifact.sha256,
        resolved.artifact.targetTriple,
      ].join(":");
      const update = identity.update;
      const current = state.builds.find((build) => build.id === state.current);
      const pending = state.builds.find((build) => build.id === state.pending);
      if (current && compareVersions(resolved.artifact.version, current.runtime.version) < 0)
        return;
      if (pending && compareVersions(resolved.artifact.version, pending.runtime.version) < 0)
        return;
      if (current && sameArtifactIdentity(current.runtime, resolved.artifact)) return;
      const failedIdentityMatches =
        update?.identity !== undefined
          ? sameArtifactIdentity(update.identity, resolved.artifact)
          : update?.buildId === buildId;
      if (update?.phase === "failed" && failedIdentityMatches && !item.forceRetry) return;
      await prepareRemoteAgentCandidate({
        target,
        requestId,
        artifact: resolved.artifact,
        source,
        control,
        install: (input) => manager.install(input),
        ...(dependencies.connect ? { connect: dependencies.connect } : {}),
      });
      stateByRoot.set(control.root, await control.registry.read());
    })();
    rootInFlight.set(control.root, task);
    try {
      await task;
    } catch (cause) {
      if (cause instanceof RemoteAgentCapacityUnavailableError) {
        stateByRoot.set(
          control.root,
          await control.registry.read().catch(() => emptyRemoteAgentRegistry()),
        );
        return;
      }
      if (!resolvedArtifact || !requestId || !buildId) throw cause;
      await control.registry
        .update((currentState) =>
          markUpdateFailure(currentState, requestId!, buildId!, resolvedArtifact!, cause),
        )
        .catch(() => undefined);
      stateByRoot.set(
        control.root,
        await control.registry.read().catch(() => emptyRemoteAgentRegistry()),
      );
      if (isDefinitiveRemoteAgentUpdateFailure(cause))
        await bestEffortFailedCandidateCleanup(target, control, manager, buildId);
    } finally {
      if (rootInFlight.get(control.root) === task) rootInFlight.delete(control.root);
    }
  };

  scheduler =
    dependencies.scheduler ??
    makeRemoteAgentUpdateScheduler({
      discoverTargets: dependencies.knownTargets ?? defaultTargetList,
      refreshSource: () => loadSource.refresh(),
      check: prepare,
      onError: logger,
    });

  let started = false;
  let unregister: (() => void) | undefined;
  const start = Effect.gen(function* () {
    if (started) return;
    started = true;
    unregister = registerRemoteAgentUpdateTrigger((target) =>
      scheduler.enqueue(target, "slot-reclaimable"),
    );
    scheduler.start();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unregister?.();
        unregister = undefined;
        scheduler.stop();
        started = false;
      }),
    );
  });

  return {
    start,
    enqueue: (input) => scheduler.enqueue(input.target, input.trigger),
    retry: (target) => scheduler.enqueue(target, "explicit-retry"),
    sourceChanged: () => {
      if (sourceChangeInFlight) return sourceChangeInFlight;
      const current = scheduler.refreshNow();
      let shared!: Promise<void>;
      shared = current.finally(() => {
        if (sourceChangeInFlight === shared) sourceChangeInFlight = undefined;
      });
      sourceChangeInFlight = shared;
      return shared;
    },
    getStatus: async (target, reconnectRequestId) => {
      if (!isReusableTarget(target, hasReusableCredentials))
        return statusFromState(
          target,
          rootByTarget.get(target) ?? null,
          stateByRoot.get(rootByTarget.get(target) ?? "") ?? emptyRemoteAgentRegistry(),
          true,
          reconnectRequestId,
        );
      const control = await openControl(target);
      const state = await control.registry.read();
      stateByRoot.set(control.root, state);
      let capacityNoncompliant = false;
      try {
        capacityNoncompliant = (await control.inventory?.())?.noncompliant ?? false;
      } catch {
        // Keep status conservative when physical inventory cannot be verified.
      }
      return statusFromState(
        target,
        control.root,
        state,
        false,
        reconnectRequestId,
        capacityNoncompliant,
      );
    },
    drain: () => scheduler.drain(),
  } satisfies RemoteAgentUpdateCoordinatorShape;
}
