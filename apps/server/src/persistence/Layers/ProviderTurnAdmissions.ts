import {
  ProviderTurnAdmission,
  type ProviderTurnAdmissionIdentity,
} from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import { Effect, Layer, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, toPersistenceDecodeCauseError } from "../Errors.ts";
import {
  ProviderTurnAdmissions,
  ProviderTurnAdmissionConflict,
  type ProviderTurnAdmissionsShape,
} from "../Services/ProviderTurnAdmissions.ts";
import { readAdmissionPayload, compactAdmissionPayload } from "./ProviderTurnAdmissions.payload.ts";
import {
  admissionOwnerAvailable,
  assertAdmissionOwnerAvailable,
} from "./ProviderTurnAdmissions.owner.ts";

type Row = Omit<ProviderTurnAdmission, "binding" | "terminalOutcome"> & {
  bindingJson: string;
  terminalOutcome: ProviderTurnAdmission["terminalOutcome"] | null;
  finalTextEncoding: string;
};

const decode = (row: Row) =>
  Effect.tryPromise({
    try: async () =>
      Schema.decodeUnknownSync(ProviderTurnAdmission)({
        ...row,
        finalText: await readAdmissionPayload(row.finalText, row.finalTextEncoding),
        terminalOutcome: row.terminalOutcome ?? undefined,
        binding: JSON.parse(row.bindingJson),
      }),
    catch: toPersistenceDecodeCauseError("ProviderTurnAdmissions.decode"),
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql`namespace, owner_thread_id AS "ownerThreadId",
    request_message_id AS "requestMessageId", binding_json AS "bindingJson", fingerprint,
    native_admission_id AS "nativeAdmissionId", turn_id AS "turnId", state, revision,
    created_at AS "createdAt", updated_at AS "updatedAt", final_text AS "finalText", terminal_outcome AS "terminalOutcome", final_text_encoding AS "finalTextEncoding"`;
  const where = (identity: ProviderTurnAdmissionIdentity) => sql`
    namespace = ${identity.namespace} AND owner_thread_id = ${identity.ownerThreadId}
    AND request_message_id = ${identity.requestMessageId}`;
  const find: ProviderTurnAdmissionsShape["find"] = Effect.fn("ProviderTurnAdmissions.find")(
    function* (identity) {
      const rows = yield* sql<Row>`SELECT ${columns} FROM provider_turn_admissions
        WHERE ${where(identity)}`.pipe(Effect.mapError(toPersistenceSqlError("admissions.find")));
      return rows[0] ? yield* decode(rows[0]) : undefined;
    },
  );
  const reserve: ProviderTurnAdmissionsShape["reserve"] = Effect.fn(
    "ProviderTurnAdmissions.reserve",
  )(function* (input) {
    const normalized = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(ProviderTurnAdmission)({
          ...input,
          state: "reserved",
          revision: 0,
          updatedAt: input.createdAt,
          finalText: null,
        }),
      catch: toPersistenceDecodeCauseError("ProviderTurnAdmissions.reserve"),
    });
    const bindingJson = JSON.stringify(normalized.binding);
    input = normalized;
    yield* assertAdmissionOwnerAvailable(sql, input.ownerThreadId);
    yield* assertAdmissionOwnerAvailable(sql, input.binding.threadId);
    yield* sql`INSERT INTO provider_turn_admissions (
        namespace, owner_thread_id, request_message_id, binding_json, fingerprint,
        native_admission_id, turn_id, state, revision, created_at, updated_at, final_text
      ) SELECT ${input.namespace}, ${input.ownerThreadId}, ${input.requestMessageId},
        ${bindingJson}, ${input.fingerprint}, ${input.nativeAdmissionId}, ${input.turnId},
        'reserved', 0, ${input.createdAt}, ${input.createdAt}, NULL
        WHERE ${admissionOwnerAvailable(sql, input.ownerThreadId)} AND ${admissionOwnerAvailable(sql, input.binding.threadId)}
        ON CONFLICT(namespace, owner_thread_id, request_message_id) DO NOTHING`.pipe(
      Effect.mapError(toPersistenceSqlError("admissions.reserve")),
    );
    const row = yield* find(input);
    if (
      !row ||
      JSON.stringify(row.binding) !== bindingJson ||
      row.fingerprint !== input.fingerprint ||
      row.nativeAdmissionId !== input.nativeAdmissionId ||
      row.turnId !== input.turnId
    ) {
      return yield* Effect.fail(
        new ProviderTurnAdmissionConflict({
          detail: "Request identity is already bound to different immutable admission material.",
        }),
      );
    }
    return row;
  });
  const transition: ProviderTurnAdmissionsShape["transition"] = Effect.fn(
    "ProviderTurnAdmissions.transition",
  )(function* (current, state, updatedAt, finalText, terminalOutcome) {
    const valid =
      (current.state === "reserved" && state === "dispatch-intent") ||
      (current.state === "dispatch-intent" && state === "accepted") ||
      (current.state === "accepted" && state === "terminal");
    if (
      !valid ||
      (state !== "terminal" && (finalText !== undefined || terminalOutcome !== undefined))
    ) {
      return yield* Effect.fail(
        new ProviderTurnAdmissionConflict({ detail: "Invalid admission transition." }),
      );
    }
    if (
      finalText !== undefined &&
      finalText.length > (current.namespace === "learning" ? 24_000 : 2_000_000)
    ) {
      return yield* new ProviderTurnAdmissionConflict({
        detail: "Admission result exceeds its workload safety bound.",
      });
    }
    const rows = yield* sql<Row>`UPDATE provider_turn_admissions
        SET state = ${state}, revision = revision + 1, updated_at = ${updatedAt},
             final_text = ${finalText ?? null}, final_text_encoding = 'plain', terminal_outcome = ${terminalOutcome ?? null}
        WHERE ${where(current)} AND state = ${current.state} AND revision = ${current.revision}
          AND binding_json = ${JSON.stringify(current.binding)} AND fingerprint = ${current.fingerprint}
           AND native_admission_id = ${current.nativeAdmissionId} AND turn_id = ${current.turnId}
           ${state === "dispatch-intent" ? sql`AND (${admissionOwnerAvailable(sql, current.ownerThreadId)}) AND (${admissionOwnerAvailable(sql, current.binding.threadId)})` : sql``}
        RETURNING ${columns}`.pipe(Effect.mapError(toPersistenceSqlError("admissions.transition")));
    if (!rows[0])
      return yield* Effect.fail(
        new ProviderTurnAdmissionConflict({ detail: "Stale admission fence." }),
      );
    return yield* decode(rows[0]);
  });
  const listUnresolved: ProviderTurnAdmissionsShape["listUnresolved"] = Effect.fn(
    "ProviderTurnAdmissions.listUnresolved",
  )(function* (limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return yield* Effect.fail(
        new ProviderTurnAdmissionConflict({ detail: "Scan limit must be 1–1000." }),
      );
    }
    const rows = yield* sql<Row>`SELECT ${columns} FROM provider_turn_admissions
        WHERE state != 'terminal' ORDER BY updated_at, namespace, owner_thread_id, request_message_id
        LIMIT ${limit}`.pipe(Effect.mapError(toPersistenceSqlError("admissions.listUnresolved")));
    return yield* Effect.forEach(rows, decode);
  });
  const latestBound: ProviderTurnAdmissionsShape["latestBound"] = Effect.fn(
    "ProviderTurnAdmissions.latestBound",
  )(function* (threadId) {
    const rows = yield* sql<Row>`SELECT ${columns} FROM provider_turn_admissions
      WHERE CASE WHEN json_valid(binding_json) THEN json_extract(binding_json, '$.threadId') END = ${threadId}
      ORDER BY created_at DESC, updated_at DESC, request_message_id DESC LIMIT 1`.pipe(
      Effect.mapError(toPersistenceSqlError("admissions.latestBound")),
    );
    return rows[0] ? yield* decode(rows[0]) : undefined;
  });
  const listBound: ProviderTurnAdmissionsShape["listBound"] = Effect.fn(
    "ProviderTurnAdmissions.listBound",
  )(function* (threadId, limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      return yield* new ProviderTurnAdmissionConflict({ detail: "Scan limit must be 1–1000." });
    const rows = yield* sql<Row>`SELECT ${columns} FROM provider_turn_admissions
      WHERE CASE WHEN json_valid(binding_json) THEN json_extract(binding_json, '$.threadId') END = ${threadId}
      ORDER BY created_at, updated_at, request_message_id LIMIT ${limit}`.pipe(
      Effect.mapError(toPersistenceSqlError("admissions.listBound")),
    );
    return yield* Effect.forEach(rows, decode);
  });
  const listBoundPage: ProviderTurnAdmissionsShape["listBoundPage"] = Effect.fn(
    "ProviderTurnAdmissions.listBoundPage",
  )(function* (input) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)
      return yield* new ProviderTurnAdmissionConflict({ detail: "Scan limit must be 1–1000." });
    const after = input.after;
    const rows = yield* sql<Row>`SELECT ${columns} FROM provider_turn_admissions
      WHERE CASE WHEN json_valid(binding_json) THEN json_extract(binding_json, '$.threadId') END = ${input.threadId}
      ${input.unresolvedOnly ? sql`AND state != 'terminal'` : sql``}
      ${after ? sql`AND (created_at, namespace, owner_thread_id, request_message_id) > (${after.createdAt}, ${after.namespace}, ${after.ownerThreadId}, ${after.requestMessageId})` : sql``}
      ORDER BY created_at, namespace, owner_thread_id, request_message_id LIMIT ${input.limit}`.pipe(
      Effect.mapError(toPersistenceSqlError("admissions.listBoundPage")),
    );
    return yield* Effect.forEach(rows, decode);
  });
  let compactAfter:
    | Pick<ProviderTurnAdmission, "createdAt" | "namespace" | "ownerThreadId" | "requestMessageId">
    | undefined;
  const compactPermit = yield* Semaphore.make(1);
  const compactTerminal: ProviderTurnAdmissionsShape["compactTerminal"] = Effect.fn(
    "ProviderTurnAdmissions.compactTerminal",
  )(function* (limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return yield* new ProviderTurnAdmissionConflict({
        detail: "Compaction limit must be 1–100.",
      });
    const candidates = yield* sql<
      NonNullable<typeof compactAfter>
    >`SELECT created_at AS "createdAt", namespace, owner_thread_id AS "ownerThreadId", request_message_id AS "requestMessageId"
      FROM provider_turn_admissions WHERE state = 'terminal' AND final_text_encoding = 'plain' AND length(final_text) > 4096
      ${compactAfter ? sql`AND (created_at, namespace, owner_thread_id, request_message_id) > (${compactAfter.createdAt}, ${compactAfter.namespace}, ${compactAfter.ownerThreadId}, ${compactAfter.requestMessageId})` : sql``}
      ORDER BY created_at, namespace, owner_thread_id, request_message_id LIMIT ${limit}`.pipe(
      Effect.mapError(toPersistenceSqlError("admissions.compactTerminal")),
    );
    let count = 0;
    for (const identity of candidates) {
      const row = yield* find(identity);
      if (!row?.finalText || row.state !== "terminal") continue;
      const encoded = yield* Effect.tryPromise({
        try: () => compactAdmissionPayload(row.finalText!),
        catch: toPersistenceDecodeCauseError("admissions.compactTerminal"),
      });
      if (!encoded) continue;
      const changed =
        yield* sql`UPDATE provider_turn_admissions SET final_text = ${encoded}, final_text_encoding = 'gzip'
        WHERE ${where(identity)} AND state = 'terminal' AND final_text_encoding = 'plain' AND revision = ${row.revision}
          AND final_text = ${row.finalText} RETURNING request_message_id`.pipe(
          Effect.mapError(toPersistenceSqlError("admissions.compactTerminal")),
        );
      count += changed.length;
    }
    compactAfter = candidates.at(-1);
    return count;
  }, compactPermit.withPermits(1));
  const service = {
    assertOwnerAvailable: (threadId) => assertAdmissionOwnerAvailable(sql, threadId),
    listBoundPage,
    compactTerminal,
    listBound,
    find,
    reserve,
    transition,
    listUnresolved,
    latestBound,
  } satisfies ProviderTurnAdmissionsShape;
  return service;
});

export const ProviderTurnAdmissionsLive = Layer.effect(ProviderTurnAdmissions, make);
