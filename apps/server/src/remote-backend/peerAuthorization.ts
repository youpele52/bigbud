/**
 * Worker peer socket authentication (WP-8B). The peer credential is the triple the SSH
 * forced-command helper sets from its fixed argv: grant id, coordinator authority and the
 * fingerprint of the one authorized key that reached it. Admission requires an unrevoked,
 * unexpired grant for this worker whose coordinator and key match, whose actions include the
 * route's action and whose ceiling bounds the requested permissions.
 *
 * @module peerAuthorization
 */
import type { PeerAction, PeerPermissionCeiling } from "@bigbud/contracts/server/remotePeer.ts";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { evaluatePeerGrant } from "../peer-orchestration/peerPermission.narrowing.ts";
import { PeerWorkerRefusal } from "../peer-orchestration/peerWorker.status.ts";
import { PeerGrantRepository } from "../persistence/Services/PeerGrants.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import {
  peerActionForRequest,
  readPeerCredential,
  type PeerCredential,
} from "./peerAuthorization.credential.ts";

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  "dispatch-unknown": 404,
  "dispatch-conflict": 409,
  "workspace-unavailable": 422,
  "child-failed": 502,
};
export const peerRefusalResponse = (refusal: PeerWorkerRefusal) =>
  HttpServerResponse.jsonUnsafe(
    { error: { code: refusal.code, message: refusal.message } },
    { status: STATUS_BY_CODE[refusal.code] ?? 403, headers: { "cache-control": "no-store" } },
  );

/** Admits one peer action under the stored grant, or fails with a typed refusal. */
export const admitPeerRequest = Effect.fn("admitPeerRequest")(function* (input: {
  readonly credential: PeerCredential;
  readonly action: PeerAction;
  readonly requested?: PeerPermissionCeiling | undefined;
}) {
  const grants = yield* PeerGrantRepository;
  const identity = yield* RemoteBackendIdentityService;
  const grant = yield* grants
    .get(input.credential.grantId)
    .pipe(
      Effect.mapError(() =>
        PeerWorkerRefusal.of("child-failed", "The worker could not read the grant."),
      ),
    );
  if (!grant) return yield* PeerWorkerRefusal.of("grant-missing", "No such peer grant.");
  if (grant.workerAuthorityId !== identity.authority.authorityId)
    return yield* PeerWorkerRefusal.of("authority-mismatch", "The grant names another worker.");
  const decision = evaluatePeerGrant({
    grant,
    coordinatorAuthorityId: input.credential.coordinatorAuthorityId,
    coordinatorKeyFingerprint: input.credential.keyFingerprint,
    action: input.action,
    requested: input.requested,
    nowMs: Date.now(),
  });
  if (decision._tag === "denied")
    return yield* PeerWorkerRefusal.of(
      decision.code,
      decision.violations.length > 0
        ? `Refused: ${decision.violations.map((violation) => violation.kind).join(", ")}.`
        : `Refused: ${decision.code}.`,
    );
  return grant;
});

/**
 * Applies to the whole peer router, including unknown and future paths: anything outside the
 * allow-list is 404 and any request carrying a client bearer or lacking the peer credential is
 * 403 before a handler runs. The peer router never mounts client RPC, `/ws` or HTTP assets.
 */
export const remotePeerAuthorizationLive = HttpRouter.middleware(
  Effect.succeed(<E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!peerActionForRequest(request.method, request.url))
        return HttpServerResponse.text("Not Found", { status: 404 });
      if (
        request.headers.authorization !== undefined ||
        request.headers.upgrade !== undefined ||
        !readPeerCredential(request.headers)
      )
        return HttpServerResponse.text("Forbidden", { status: 403 });
      return yield* app;
    }),
  ),
  { global: true },
);
