/**
 * Owner-only peer grant administration on the authenticated client socket (WP-8C). `bigbud peer
 * grant|revoke|list` reaches it with this account's client credential; a peer credential never
 * can (the peer socket does not mount it and the helper only reaches the peer socket).
 *
 * @module peerGrantOwnerRoute
 */
import { randomUUID } from "node:crypto";

import { PROVIDER_KINDS } from "@bigbud/contracts/constants/provider.constant.ts";
import {
  PEER_GRANT_OWNER_MAX_BYTES,
  PEER_GRANT_OWNER_PATH,
} from "@bigbud/contracts/constants/remotePeer.constant.ts";
import type { PeerGrant } from "@bigbud/contracts/server/remotePeer.ts";
import {
  PeerGrantOwnerRequest,
  PeerGrantOwnerResult,
  type PeerGrantOwnerRefusalCode,
} from "@bigbud/contracts/server/remotePeer.wire.ts";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { PeerGrantRepositoryLive } from "../persistence/Layers/PeerGrants.ts";
import { PeerGrantRepository } from "../persistence/Services/PeerGrants.ts";
import { ServerConfig } from "../startup/config.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { readMobileOwnerJson } from "./mobileOwnerRequest.ts";

const MAX_GRANT_MS = 366 * 24 * 60 * 60 * 1000;
const headers = { "cache-control": "no-store" };
const STATUS: Record<PeerGrantOwnerRefusalCode, number> = {
  "invalid-request": 400,
  "authority-mismatch": 403,
  "exceeds-ceiling": 403,
  "unknown-grant": 404,
  unavailable: 503,
};
const refuse = (code: PeerGrantOwnerRefusalCode) =>
  HttpServerResponse.jsonUnsafe({ refused: code }, { status: STATUS[code], headers });
const reply = (grants: ReadonlyArray<PeerGrant>) =>
  HttpServerResponse.jsonUnsafe(Schema.encodeUnknownSync(PeerGrantOwnerResult)({ grants }), {
    headers,
  });
const decode = Schema.decodeUnknownSync(PeerGrantOwnerRequest);

export const peerGrantOwnerRoute = HttpRouter.add(
  "POST",
  PEER_GRANT_OWNER_PATH,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (config.mode !== "remote") return refuse("unavailable");
    const input = yield* readMobileOwnerJson(PEER_GRANT_OWNER_MAX_BYTES, (value) =>
      decode(value, { onExcessProperty: "error" }),
    );
    if (!input) return refuse("invalid-request");
    const identity = yield* RemoteBackendIdentityService;
    if (input.authorityId !== identity.authority.authorityId) return refuse("authority-mismatch");
    const grants = yield* PeerGrantRepository;
    const now = new Date();
    switch (input.action) {
      case "list":
        return reply(yield* grants.list(256));
      case "revoke": {
        const revoked = yield* grants.revoke(input.grantId, now.toISOString());
        return revoked ? reply([revoked]) : refuse("unknown-grant");
      }
      case "issue": {
        const expiresAtMs = Date.parse(input.expiresAt);
        if (
          !Number.isFinite(expiresAtMs) ||
          expiresAtMs <= now.getTime() ||
          expiresAtMs - now.getTime() > MAX_GRANT_MS
        )
          return refuse("invalid-request");
        // The worker's local policy: any provider and mode, but only workspaces it already has.
        const readModel = yield* (yield* OrchestrationEngineService).getReadModel();
        const roots = new Set(
          readModel.projects
            .filter((project) => project.deletedAt === null && !project.deletingAt)
            .flatMap((project) => (project.workspaceRoot ? [project.workspaceRoot] : [])),
        );
        const localCeiling = {
          runtimeMode: "full-access",
          providers: [...PROVIDER_KINDS],
          workspaceRoots: input.ceiling.workspaceRoots.filter((root) => roots.has(root)),
        } as const;
        const issued = yield* grants
          .issue({
            grant: {
              grantId: randomUUID(),
              coordinatorAuthorityId: input.coordinatorAuthorityId,
              coordinatorKeyFingerprint: input.coordinatorKeyFingerprint,
              workerAuthorityId: identity.authority.authorityId,
              actions: input.actions,
              ceiling: input.ceiling,
              issuedAt: now.toISOString(),
              expiresAt: new Date(expiresAtMs).toISOString(),
              revokedAt: null,
            },
            localCeiling,
          })
          .pipe(
            Effect.map((grant): PeerGrant | null => grant),
            Effect.catchTag("PeerGrantExceedsCeiling", () =>
              Effect.succeed<PeerGrant | null>(null),
            ),
          );
        return issued ? reply([issued]) : refuse("exceeds-ceiling");
      }
    }
  }).pipe(Effect.catch(() => Effect.succeed(refuse("unavailable")))),
);

/** The owner route with its grant repository built once for every request. */
export const peerGrantOwnerRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const repository = yield* Layer.build(PeerGrantRepositoryLive);
    return peerGrantOwnerRoute.pipe(HttpRouter.provideRequest(Layer.succeedServices(repository)));
  }),
);
