import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ThreadRetentionPolicy } from "@bigbud/contracts/core/settings.threadRetention.ts";
import type { ThreadRetentionRolloutSource } from "../ws/serverSettings.retention.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";

export const runThreadRetentionSettingsMigration = Effect.fn("runThreadRetentionSettingsMigration")(
  function* () {
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    const settings = yield* ServerSettingsService;
    if (sqlOption._tag === "None") return;
    const sql = sqlOption.value;
    const authorityRows = yield* sql<{
      policy: ThreadRetentionPolicy;
      source: ThreadRetentionRolloutSource | "explicit";
    }>`
      SELECT policy, source FROM thread_retention_policy_authority WHERE singleton_id = 1
    `;
    const existing = authorityRows[0];
    if (existing !== undefined) {
      if (settings.initializeThreadRetentionPolicy) {
        yield* settings.initializeThreadRetentionPolicy(existing.policy, existing.source);
      }
      return;
    }
    const rows = yield* sql<{ hadUserThreads: number }>`
    SELECT had_user_threads AS "hadUserThreads"
    FROM thread_retention_rollout WHERE singleton_id = 1
  `;
    const hadUserThreads = rows[0]?.hadUserThreads === 1;
    const policy = hadUserThreads ? "never" : "7-days";
    const source = hadUserThreads ? ("rollout-protected" as const) : ("rollout-automatic" as const);
    yield* sql`
      INSERT INTO thread_retention_policy_authority (singleton_id, policy, source, updated_at)
      VALUES (1, ${policy}, ${source}, ${new Date().toISOString()})
    `;
    if (settings.initializeThreadRetentionPolicy) {
      yield* settings.initializeThreadRetentionPolicy(policy, source);
    }
  },
);
