/**
 * Worker peer router (WP-8B): exactly delegate, status, follow and cancel, all POST JSON. It is
 * served only on the owner-private peer socket and never mounts client RPC, `/ws` or assets.
 *
 * @module peerRoutes
 */
import type { PeerAction, PeerPermissionCeiling } from "@bigbud/contracts/server/remotePeer.ts";
import {
  PEER_REQUEST_MAX_BYTES,
  PEER_ROUTE_PATHS,
} from "@bigbud/contracts/constants/remotePeer.constant.ts";
import {
  PeerChildStatus,
  PeerDelegateRequest,
  PeerDelegateResponse,
  PeerDispatchRef,
  PeerFollowRequest,
} from "@bigbud/contracts/server/remotePeer.wire.ts";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { peerWorkerDelegate } from "../peer-orchestration/peerWorker.delegate.ts";
import type { PeerWorkerDeps } from "../peer-orchestration/peerWorker.read.ts";
import { PeerChildStarterService } from "../peer-orchestration/peerWorker.starter.layer.ts";
import {
  peerWorkerCancel,
  peerWorkerFollow,
  peerWorkerStatus,
} from "../peer-orchestration/peerWorker.follow.ts";
import { PeerWorkerRefusal } from "../peer-orchestration/peerWorker.status.ts";
import { PeerChildRepository } from "../persistence/Services/PeerChildren.ts";
import type { PeerGrant } from "@bigbud/contracts/server/remotePeer.ts";
import { readMobileOwnerJson } from "./mobileOwnerRequest.ts";
import {
  admitPeerRequest,
  peerRefusalResponse,
  remotePeerAuthorizationLive,
} from "./peerAuthorization.ts";
import { readPeerCredential } from "./peerAuthorization.credential.ts";

const strict = { onExcessProperty: "error" } as const;
const headers = { "cache-control": "no-store" };

function peerRoute<I, O>(
  action: PeerAction,
  request: Schema.Decoder<I>,
  response: Schema.Encoder<O>,
  requested: (input: I) => PeerPermissionCeiling | undefined,
  handle: (deps: PeerWorkerDeps, grant: PeerGrant, input: I) => Effect.Effect<O, PeerWorkerRefusal>,
) {
  const decode = Schema.decodeUnknownSync(request as Schema.Decoder<I, never>);
  const encode = Schema.encodeUnknownSync(response as Schema.Encoder<O, never>);
  return HttpRouter.add(
    "POST",
    PEER_ROUTE_PATHS[action],
    Effect.gen(function* () {
      const http = yield* HttpServerRequest.HttpServerRequest;
      const credential = readPeerCredential(http.headers);
      if (!credential) return HttpServerResponse.text("Forbidden", { status: 403 });
      const input = yield* readMobileOwnerJson(PEER_REQUEST_MAX_BYTES, (value) =>
        decode(value, strict),
      );
      if (input === null) return HttpServerResponse.text("Bad Request", { status: 400 });
      const grant = yield* admitPeerRequest({ credential, action, requested: requested(input) });
      const deps: PeerWorkerDeps = {
        engine: yield* OrchestrationEngineService,
        children: yield* PeerChildRepository,
        starter: yield* PeerChildStarterService,
      };
      const result = yield* handle(deps, grant, input);
      return HttpServerResponse.jsonUnsafe(encode(result), { headers });
    }).pipe(
      Effect.catchTag("PeerWorkerRefusal", (refusal) =>
        Effect.succeed(peerRefusalResponse(refusal)),
      ),
    ),
  );
}

export const remotePeerRoutesLayer = Layer.mergeAll(
  peerRoute(
    "delegate",
    PeerDelegateRequest,
    PeerDelegateResponse,
    (input) => input.permissions,
    peerWorkerDelegate,
  ),
  peerRoute(
    "status",
    PeerDispatchRef,
    PeerChildStatus,
    () => undefined,
    (deps, grant, input) => peerWorkerStatus(deps, grant, input.dispatchId),
  ),
  peerRoute(
    "follow",
    PeerFollowRequest,
    PeerChildStatus,
    () => undefined,
    (deps, grant, input) => peerWorkerFollow(deps, grant, input.dispatchId, input.waitMs),
  ),
  peerRoute(
    "cancel",
    PeerDispatchRef,
    PeerChildStatus,
    () => undefined,
    (deps, grant, input) => peerWorkerCancel(deps, grant, input.dispatchId),
  ),
).pipe(Layer.provide(remotePeerAuthorizationLive));
