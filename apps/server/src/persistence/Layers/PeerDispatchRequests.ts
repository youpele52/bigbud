import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PeerDelegateRequest } from "@bigbud/contracts/server/remotePeer.wire.ts";

import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import {
  PeerDispatchRequestRepository,
  type PeerDispatchRequestRepositoryShape,
} from "../Services/PeerDispatchRequests.ts";

const decode = Schema.decodeUnknownSync(PeerDelegateRequest);
const encode = Schema.encodeUnknownSync(PeerDelegateRequest);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sqlError = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`PeerDispatchRequestRepository.${operation}`));
  const get: PeerDispatchRequestRepositoryShape["get"] = (dispatchId) =>
    sql<{ requestJson: string }>`SELECT request_json AS "requestJson"
      FROM peer_dispatch_requests WHERE dispatch_id = ${dispatchId}`.pipe(
      sqlError("get"),
      Effect.flatMap((rows) =>
        rows[0]
          ? Effect.try({
              try: () => decode(JSON.parse(rows[0]!.requestJson)),
              catch: toPersistenceDecodeCauseError("PeerDispatchRequestRepository.decode"),
            })
          : Effect.undefined,
      ),
    );
  return {
    get,
    save: Effect.fn("PeerDispatchRequestRepository.save")(function* (request, createdAt) {
      const json = yield* Effect.try({
        try: () => JSON.stringify(encode(request)),
        catch: toPersistenceDecodeCauseError("PeerDispatchRequestRepository.encode"),
      });
      yield* sql`INSERT INTO peer_dispatch_requests (dispatch_id, request_json, created_at)
        VALUES (${request.dispatchId}, ${json}, ${createdAt})
        ON CONFLICT(dispatch_id) DO NOTHING`.pipe(sqlError("save"));
      return (yield* get(request.dispatchId)) ?? request;
    }),
  } satisfies PeerDispatchRequestRepositoryShape;
});

export const PeerDispatchRequestRepositoryLive = Layer.effect(PeerDispatchRequestRepository, make);
