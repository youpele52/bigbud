import { Effect, Scope, ServiceMap } from "effect";

import { assertSshExecutionTargetReady } from "../ssh/sshVerification.ts";
import { isRemoteAgentExecutionTarget } from "./remoteAgentDefault.ts";
import { openRemoteAgentControl, type RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentInstallSource } from "./remoteAgentInstallManager.ts";
import type { RemoteAgentArtifact } from "./remoteAgentArtifact.ts";
import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";
import {
  makeRemoteAgentInstallSourceLoader,
  type RemoteAgentInstallSourceLoader,
} from "./remoteAgentInstallSource.ts";
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
import { makeRemoteAgentDiscovery } from "./remoteAgentUpdate.discovery.ts";
import type { RemoteAgentAdmissionPreparation } from "./remoteAgentUpdate.admission.types.ts";
import { remoteAgentFailureDetail } from "./remoteAgentFailure.ts";
import { makeRemoteAgentAdmissionPreparation } from "./remoteAgentUpdate.admission.ts";
import { makeRemoteAgentPreparationQueue } from "./remoteAgentUpdate.queue.ts";
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
  readonly prepareForAdmission: (
    target: string,
    requestId: string,
  ) => Promise<RemoteAgentAdmissionPreparation>;
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

function stateKey(target: string, root: string): string {
  return `${target}\u0000${root}`;
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
          cause: remoteAgentFailureDetail(cause),
        }),
      );
    });
  let scheduler: RemoteAgentUpdateScheduler;
  const runPreparation = makeRemoteAgentPreparationQueue();
  const rootByTarget = new Map<string, string>();
  const stateByRoot = new Map<string, RemoteAgentRegistry>();
  let sourceChangeInFlight: Promise<void> | undefined;

  const onState = (target: string, control: RemoteAgentControl, state: RemoteAgentRegistry) => {
    rootByTarget.set(target, control.root);
    stateByRoot.set(stateKey(target, control.root), state);
  };
  const discover = makeRemoteAgentDiscovery({
    manager,
    loadSource,
    onState,
    ...(dependencies.connect ? { connect: dependencies.connect } : {}),
  });
  const prepare = async (target: string, item: RemoteAgentUpdateScheduleItem): Promise<void> => {
    if (!isRemoteAgentExecutionTarget(target)) return;
    if (
      !item.triggers.has("authenticated") &&
      !item.forceRetry &&
      !isReusableTarget(target, hasReusableCredentials)
    )
      return;
    const control = await openControl(target);
    rootByTarget.set(target, control.root);
    await runPreparation(stateKey(target, control.root), async () => {
      await discover(target, control, { refreshSource: false, forceRetry: item.forceRetry });
    });
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
          stateByRoot.get(stateKey(target, rootByTarget.get(target) ?? "")) ??
            emptyRemoteAgentRegistry(),
          true,
          reconnectRequestId,
        );
      const control = await openControl(target);
      const state = await control.registry.read();
      stateByRoot.set(stateKey(target, control.root), state);
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
    prepareForAdmission: makeRemoteAgentAdmissionPreparation({
      openControl,
      runPreparation,
      discover,
    }),
  } satisfies RemoteAgentUpdateCoordinatorShape;
}
