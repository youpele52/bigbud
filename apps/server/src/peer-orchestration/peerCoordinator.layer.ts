/**
 * Coordinator composition (M6 WP-8D/8E): builds the dispatcher over the real repositories and the
 * dedicated-key SSH transport, registers it for the thread tools and the pairing RPC, and resumes
 * followers for every unsettled dispatch on backend start. Remote mode only.
 *
 * @module peerCoordinator.layer
 */
import { randomUUID } from "node:crypto";

import { Effect, Layer, Option } from "effect";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { loadPeerChildThread } from "./peerWorker.read.ts";
import { makeEnginePeerDeliver } from "../orchestration-tools/peerDispatch.delivery.ts";
import {
  defaultPeerRetryDelayMs,
  type PeerCoordinatorDeps,
} from "../orchestration-tools/peerDispatch.deps.ts";
import {
  makePeerDispatchService,
  type PeerDispatchServiceShape,
} from "../orchestration-tools/peerDispatch.service.ts";
import { setThreadPeerToolHandler } from "../orchestration-tools/ThreadPeerTools.ts";
import { PeerDispatchRepositoryLive } from "../persistence/Layers/PeerDispatches.ts";
import { PeerDispatchRequestRepositoryLive } from "../persistence/Layers/PeerDispatchRequests.ts";
import { PeerPairingRepositoryLive } from "../persistence/Layers/PeerPairings.ts";
import { PeerDispatchRepository } from "../persistence/Services/PeerDispatches.ts";
import { PeerDispatchRequestRepository } from "../persistence/Services/PeerDispatchRequests.ts";
import { PeerPairingRepository } from "../persistence/Services/PeerPairings.ts";
import { RemoteBackendIdentityService } from "../remote-backend/identity.service.ts";
import { ServerConfig } from "../startup/config.ts";
import {
  makeSshPeerTransport,
  peerCoordinatorKeyDirectory,
  scanPeerHostKeys,
} from "./peerCoordinator.transport.ts";
import type { PeerPairingDeps } from "./peerPairing.ts";

export interface PeerCoordinatorRegistration {
  readonly service: PeerDispatchServiceShape;
  readonly pairing: PeerPairingDeps;
}

let registered: PeerCoordinatorRegistration | null = null;

/** The running coordinator, or null (local mode, or before startup). */
export const getPeerCoordinator = () => registered;

export const PeerCoordinatorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const identity = yield* Effect.serviceOption(RemoteBackendIdentityService);
    const engine = yield* OrchestrationEngineService;
    const keyDirectory = peerCoordinatorKeyDirectory(config.stateDir);
    const deps: PeerCoordinatorDeps = {
      coordinatorAuthorityId: Option.isSome(identity) ? identity.value.authority.authorityId : null,
      dispatches: yield* PeerDispatchRepository,
      requests: yield* PeerDispatchRequestRepository,
      pairings: yield* PeerPairingRepository,
      transport: makeSshPeerTransport({ keyDirectory }),
      deliver: makeEnginePeerDeliver(engine),
      callerRuntimeMode: (threadId) =>
        loadPeerChildThread(engine, threadId).pipe(
          Effect.map((thread) => thread?.runtimeMode ?? null),
          Effect.orElseSucceed(() => null),
        ),
      setupErrors: new Map(),
      now: () => new Date().toISOString(),
      newDispatchId: randomUUID,
      retryDelayMs: defaultPeerRetryDelayMs,
      followWaitMs: 25_000,
    };
    const service = yield* makePeerDispatchService(deps);
    registered = {
      service,
      pairing: {
        coordinator: deps,
        keyDirectory,
        kick: service.kick,
        scanHostKeys: scanPeerHostKeys,
      },
    };
    setThreadPeerToolHandler(service);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        registered = null;
        setThreadPeerToolHandler(null);
      }),
    );
    const resumed = yield* service.resume().pipe(Effect.orElseSucceed(() => 0));
    if (resumed > 0) yield* Effect.logInfo("peer dispatch followers resumed", { resumed });
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      PeerDispatchRepositoryLive,
      PeerDispatchRequestRepositoryLive,
      PeerPairingRepositoryLive,
    ),
  ),
);
