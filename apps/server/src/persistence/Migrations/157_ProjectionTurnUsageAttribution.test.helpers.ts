import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { captureBaselineRows } from "../Layers/ProjectionBaselines.capture.ts";
import { BASELINE_SCRATCH_ID } from "../ProjectionBaselineRows.ts";
import type { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";

export const projectId = ProjectId.makeUnsafe("usage-baseline-project");
export const threadId = ThreadId.makeUnsafe("usage-baseline-thread");
export const at = (second: number) =>
  `2026-09-01T12:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`;

export type AppendInput = Parameters<OrchestrationEventStore["Service"]["append"]>[0];

let eventCount = 0;
export const event = (type: string, payload: Record<string, unknown>, second: number) => {
  eventCount += 1;
  return {
    type,
    eventId: EventId.makeUnsafe(`usage-baseline-event-${eventCount}`),
    aggregateKind: type.startsWith("project.") ? "project" : "thread",
    aggregateId: type.startsWith("project.") ? projectId : threadId,
    occurredAt: at(second),
    commandId: CommandId.makeUnsafe(`usage-baseline-command-${eventCount}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload,
  } as unknown as AppendInput;
};

export const setupEvents = () => [
  event(
    "project.created",
    {
      projectId,
      title: "Usage baseline",
      workspaceRoot: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: at(0),
      updatedAt: at(0),
    },
    0,
  ),
  event(
    "thread.created",
    {
      threadId,
      projectId,
      title: "Usage baseline thread",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: at(1),
      updatedAt: at(1),
    },
    1,
  ),
];

/** A request written before migration 133: it carries no `usageAttribution`. */
export const legacyRequest = (
  turn: number,
  model: string,
  extra: Record<string, unknown> = { interactionMode: "plan" },
) =>
  event(
    "thread.turn-start-requested",
    {
      threadId,
      messageId: MessageId.makeUnsafe(`legacy-prompt-${turn}`),
      modelSelection: { provider: "codex", model },
      runtimeMode: "full-access",
      ...extra,
      createdAt: at(turn * 10),
    },
    turn * 10,
  );

/** Starts and completes the turn of `legacyRequest(turn)`. */
export const legacyTurnRun = (turn: number) => {
  const turnId = TurnId.makeUnsafe(`legacy-turn-${turn}`);
  const second = turn * 10;
  return [
    event(
      "thread.session-set",
      {
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: at(second + 1),
        },
      },
      second + 1,
    ),
    event(
      "thread.turn-diff-completed",
      {
        threadId,
        turnId,
        checkpointTurnCount: turn,
        checkpointRef: CheckpointRef.makeUnsafe(`refs/t3/checkpoints/${threadId}/turn/${turn}`),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe(`legacy-answer-${turn}`),
        completedAt: at(second + 2),
      },
      second + 2,
    ),
  ];
};

export const legacyTurn = (turn: number, model: string) => [
  legacyRequest(turn, model),
  ...legacyTurnRun(turn),
];

/** Leaves the thread's turns as a projection before migration 133 left them: no usage. */
export const forgetUsage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE projection_turns SET usage_provider = NULL, usage_model = NULL,
    usage_interaction_mode = NULL, usage_attribution_source = NULL
    WHERE thread_id = ${threadId}`;
});

export const readTurns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly turnId: string | null;
    readonly provider: string | null;
    readonly model: string | null;
    readonly mode: string | null;
    readonly source: string | null;
  }>`
    SELECT turn_id AS "turnId", usage_provider AS provider, usage_model AS model,
      usage_interaction_mode AS mode, usage_attribution_source AS source
    FROM projection_turns WHERE thread_id = ${threadId} ORDER BY turn_id
  `;
});

export const backfilled = (turnId: string | null, model: string, mode = "plan") => ({
  turnId,
  provider: "codex",
  model,
  mode,
  source: "backfill",
});

export const liveDigest = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* captureBaselineRows(sql, BASELINE_SCRATCH_ID);
  yield* sql`DELETE FROM projection_baseline_rows WHERE baseline_id = ${BASELINE_SCRATCH_ID}`;
  return digest;
});

export const readBaselines = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly sequence: number; readonly status: string; readonly hash: string }>`
    SELECT sequence, verification_status AS status, payload_hash AS hash
    FROM projection_baselines ORDER BY sequence
  `;
});
