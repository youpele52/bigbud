import type {
  ServerPreviewThreadRetentionInput,
  ServerSetThreadRetentionPolicyInput,
  ServerStartThreadRetentionInput,
  ServerListThreadRetentionRunsResult,
  ServerThreadRetentionPreview,
  ServerThreadRetentionRun,
  ServerThreadRetentionResult,
  ServerThreadRetentionError,
} from "@bigbud/contracts/server/threadRetention.ts";
import type { Effect } from "effect";
import * as ServiceMap from "effect/ServiceMap";

export interface ThreadRetentionShape {
  readonly preview: (
    input: ServerPreviewThreadRetentionInput,
  ) => Effect.Effect<ServerThreadRetentionPreview, ServerThreadRetentionError>;
  readonly enqueue: (
    input: ServerStartThreadRetentionInput,
  ) => Effect.Effect<ServerThreadRetentionResult, ServerThreadRetentionError>;
  readonly getRun: (
    runId: string,
  ) => Effect.Effect<ServerThreadRetentionRun, ServerThreadRetentionError>;
  readonly listRuns: (
    limit?: number,
  ) => Effect.Effect<ServerListThreadRetentionRunsResult, ServerThreadRetentionError>;
  readonly setPolicy: (
    input: ServerSetThreadRetentionPolicyInput,
  ) => Effect.Effect<
    import("@bigbud/contracts/core/settings.ts").ServerSettings,
    ServerThreadRetentionError
  >;
  readonly runScheduledOnce: Effect.Effect<void, ServerThreadRetentionError>;
  readonly start: Effect.Effect<void>;
}

export class ThreadRetention extends ServiceMap.Service<ThreadRetention, ThreadRetentionShape>()(
  "bigbud/retention/Services/ThreadRetention",
) {}
