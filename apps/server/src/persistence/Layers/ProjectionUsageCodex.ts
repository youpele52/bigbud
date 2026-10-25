import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { UsageAccountingV2 } from "@bigbud/contracts/orchestration/providerRuntime.usage";
import type { ProjectionUsageContribution } from "../Services/ProjectionThreadActivities.ts";
import { reduceCodexUsage } from "./ProjectionUsageCodex.reducer.ts";
import { decodeCodexState } from "./ProjectionUsageCodex.state.ts";
import { toPersistenceSqlError } from "../Errors.ts";

export function retireCodexUsageTurns(
  sql: SqlClient.SqlClient,
  threadId: string,
  turnIds: readonly string[],
) {
  return Effect.gen(function* () {
    for (const turnId of turnIds) {
      yield* sql`INSERT INTO projection_usage_codex_retired_turns VALUES (${threadId}, ${turnId}) ON CONFLICT DO NOTHING`;
    }
  }).pipe(Effect.mapError(toPersistenceSqlError("ProjectionUsageCodex.retire")));
}

/** Called in the contribution transaction so cursor and consumption advance atomically. */
export function reducePersistedCodexUsage(
  sql: SqlClient.SqlClient,
  row: ProjectionUsageContribution,
) {
  return Effect.gen(function* () {
    if (!row.codexObservation) return row;
    if (!row.turnId) return undefined;
    const [stored] = yield* sql<{
      state_json: string;
    }>`SELECT state_json FROM projection_usage_codex_state WHERE thread_id = ${row.threadId}`;
    const decoded = stored ? decodeCodexState(stored.state_json) : undefined;
    const state = decoded?.state;
    if (decoded?.upgraded) {
      // Old captured baselines may still contain arrays even after migration 134.
      for (const turnId of decoded.retired) {
        yield* sql`INSERT INTO projection_usage_codex_retired_turns VALUES (${row.threadId}, ${turnId}) ON CONFLICT DO NOTHING`;
      }
      yield* sql`UPDATE projection_usage_codex_state SET state_json = ${JSON.stringify(state)} WHERE thread_id = ${row.threadId}`;
    }
    const retired =
      yield* sql`SELECT 1 FROM projection_usage_codex_retired_turns WHERE thread_id = ${row.threadId} AND turn_id = ${row.turnId}`;
    if (retired.length > 0) return undefined;
    const [previous] = yield* sql<{
      accounting_json: string | null;
      used_tokens: number;
      source_sequence: number | null;
      updated_at: string;
    }>`SELECT accounting_json, used_tokens, source_sequence, updated_at FROM projection_usage_contributions WHERE contribution_id = ${row.contributionId}`;
    if (
      previous?.accounting_json &&
      ((previous.source_sequence !== null &&
        (row.sourceSequence === null || row.sourceSequence < previous.source_sequence)) ||
        (previous.source_sequence === null &&
          row.sourceSequence === null &&
          row.updatedAt < previous.updated_at))
    )
      return undefined;
    let existing: UsageAccountingV2 | undefined;
    if (previous?.accounting_json) {
      const decoded: unknown = JSON.parse(previous.accounting_json);
      if (Schema.is(UsageAccountingV2)(decoded)) existing = decoded;
    }
    if (previous && !existing) {
      existing = {
        version: 2,
        source: "provider-reported",
        basis: "codex-legacy-recovery",
        completeness: "partial",
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        reportedTotal: null,
        subtotal: previous.used_tokens,
      };
    }
    if (state && state.turnId !== row.turnId && previous) return undefined;
    if (state && state.turnId !== row.turnId) {
      const turns = yield* sql<{
        turn_id: string;
        requested_at: string;
      }>`SELECT turn_id, requested_at
        FROM projection_turns WHERE thread_id = ${row.threadId} AND turn_id IN (${state.turnId}, ${row.turnId})`;
      const incoming = turns.find((turn) => turn.turn_id === row.turnId);
      const active = turns.find((turn) => turn.turn_id === state.turnId);
      // A first late observation of an older (or unlinked) turn must not move the live baseline.
      if (!incoming || (active && incoming.requested_at < active.requested_at)) return undefined;
    }
    const next = reduceCodexUsage(state, row.turnId, row.codexObservation, existing);
    if (!next) return undefined;
    if (state && state.turnId !== row.turnId) {
      yield* sql`INSERT INTO projection_usage_codex_retired_turns VALUES (${row.threadId}, ${state.turnId}) ON CONFLICT DO NOTHING`;
    }
    yield* sql`INSERT INTO projection_usage_codex_state (thread_id, state_json)
      VALUES (${row.threadId}, ${JSON.stringify(next)}) ON CONFLICT (thread_id) DO UPDATE SET state_json = excluded.state_json`;
    if (!next.measured) return undefined;
    return {
      ...row,
      accounting: next.amount,
      usedTokens: next.amount.subtotal,
      inputTokens: next.amount.inputTokens ?? 0,
      outputTokens: next.amount.outputTokens ?? 0,
      cachedInputTokens: next.amount.cacheReadTokens ?? 0,
      reasoningOutputTokens: next.amount.reasoningTokens ?? 0,
    };
  });
}
