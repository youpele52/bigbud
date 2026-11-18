/**
 * Worker child starter service (F-P8-3), built once with the worker peer endpoint so its fibers
 * and periodic sweep outlive individual peer requests.
 *
 * @module peerWorker.starter.layer
 */
import { Effect, Layer, ServiceMap } from "effect";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { PeerChildRepository } from "../persistence/Services/PeerChildren.ts";
import { makePeerChildStarter, type PeerChildStarter } from "./peerWorker.start.ts";

export class PeerChildStarterService extends ServiceMap.Service<
  PeerChildStarterService,
  PeerChildStarter
>()("bigbud/peer-orchestration/PeerChildStarterService") {}

export const PeerChildStarterLive = Layer.effect(
  PeerChildStarterService,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const children = yield* PeerChildRepository;
    return yield* makePeerChildStarter({ engine, children });
  }),
);
