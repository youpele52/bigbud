import { randomUUID } from "node:crypto";
import {
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { OrchestrationQueuedPrompt } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { requireThread } from "../commandInvariants.ts";
import { requireActiveOpencodeIntegration } from "../decider.opencodePolicy.ts";
import { withThreadTitleOwnership } from "../deciderThreads.titleOwnership.ts";
import {
  decideThreadTurnStartCommand,
  requireThreadReadyForMutation,
} from "../deciderThreads.turn.start.ts";
import { nowIso, withEventBase } from "../deciderHelpers.ts";
import { queueDecisionError } from "../QueuedPromptDecision.logic.ts";
import {
  canAutoDispatchQueuedPrompts,
  countedQueuedPrompts,
  hasActiveQueueReservation,
} from "../QueuedPromptPolicy.logic.ts";
import {
  MAX_QUEUED_PROMPTS,
  PROMPT_QUEUE_FULL_DETAIL,
  queuedPromptToTurnStartCommand,
} from "../ThreadPromptAdmission.logic.ts";
import { requireThreadAttachmentsSupported } from "../ThreadAttachmentAdmission.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";

type RecoveredCommand = Extract<OrchestrationCommand, { type: "thread.queued-prompt.recovered" }>;
const decodePrompt = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationQueuedPrompt));

export const readRecoveredQueueDraft = Effect.fn("readRecoveredQueueDraft")(function* (
  sql: SqlClient.SqlClient,
  command: RecoveredCommand,
) {
  const [draft] = yield* sql<{ promptJson: string }>`SELECT prompt_json AS "promptJson"
    FROM recovered_queue_drafts WHERE claim_id = ${command.claimId} AND thread_id = ${command.threadId}`;
  return draft ? yield* decodePrompt(draft.promptJson) : undefined;
});

export const decideRecoveredQueueCommand = Effect.fn("decideRecoveredQueueCommand")(function* (
  sql: SqlClient.SqlClient,
  command: RecoveredCommand,
  readModel: OrchestrationReadModel,
) {
  const stored = yield* readRecoveredQueueDraft(sql, command);
  if (!stored) return yield* queueDecisionError("queue_stale_selection");
  if (command.action === "discard") return [];
  const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
  yield* requireThreadReadyForMutation({ thread, command });
  if (thread.archivedAt != null) return yield* queueDecisionError("queue_unavailable");
  const { alreadySent: _, pendingInteractionGate: __, ...content } = stored;
  const createdAt = nowIso();
  const prompt = { ...content, id: MessageId.makeUnsafe(randomUUID()), createdAt };
  const start = queuedPromptToTurnStartCommand({
    prompt,
    thread,
    commandId: command.commandId,
    createdAt,
  });
  yield* requireActiveOpencodeIntegration(start, readModel);
  yield* requireThreadAttachmentsSupported(thread, start);
  const queue = thread.queuedPrompts ?? [];
  // The explicit send may release an empty hold, never a hold covering other queue entries.
  if (queue.length === 0 && canAutoDispatchQueuedPrompts({ ...thread, queueHold: false })) {
    const events = yield* decideThreadTurnStartCommand({ command: start, readModel });
    const released = thread.queueHold
      ? events.map((base) => {
          const event = base as OrchestrationEvent;
          return event.type === "thread.turn-start-requested"
            ? { ...base, payload: { ...event.payload, releaseEmptyQueueHold: true } }
            : base;
        })
      : events;
    return withThreadTitleOwnership(start, readModel, released);
  }
  if (queue.length === 0 && thread.queueHold) {
    // Do not turn this draft into a new, sole held row while the session still cannot send.
    return yield* queueDecisionError(
      hasActiveQueueReservation(thread) || thread.pendingInterruptFlushIntent
        ? "queue_reserved"
        : "queue_busy",
    );
  }
  if (countedQueuedPrompts(queue) >= MAX_QUEUED_PROMPTS) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      code: "prompt_queue_full",
      detail: PROMPT_QUEUE_FULL_DETAIL,
    });
  }
  return [
    {
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: createdAt,
        commandId: command.commandId,
      }),
      type: "thread.prompt-queued",
      payload: { threadId: thread.id, prompt, queuePosition: queue.length + 1 },
    },
  ] satisfies ReadonlyArray<Omit<OrchestrationEvent, "sequence">>;
});

/** These edits share the same transaction as the queue event and command receipt. */
export const commitRecoveredQueueCommand = Effect.fn("commitRecoveredQueueCommand")(function* (
  sql: SqlClient.SqlClient,
  command: OrchestrationCommand,
  model: OrchestrationReadModel,
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  if (command.type === "thread.queued-prompt.claim") {
    const prompt = model.threads
      .find((thread) => thread.id === command.threadId)
      ?.queuedPrompts?.find((entry) => entry.id === command.messageId);
    if (!prompt || !events.some((event) => event.type === "thread.queued-prompt-removed"))
      return yield* queueDecisionError("queue_stale_selection");
    yield* sql`INSERT INTO recovered_queue_drafts (claim_id, thread_id, prompt_json)
      VALUES (${command.commandId}, ${command.threadId}, ${JSON.stringify(prompt)})`;
    for (const attachment of prompt.attachments ?? []) {
      if (attachment.type !== "file" && attachment.type !== "image") continue;
      yield* sql`INSERT OR IGNORE INTO recovered_queue_draft_attachments (attachment_id, claim_id)
        VALUES (${attachment.id}, ${command.commandId})`;
    }
  } else if (command.type === "thread.queued-prompt.recovered") {
    if (command.action === "send" && !events.length)
      return yield* queueDecisionError("queue_unavailable");
    const rows = yield* sql`DELETE FROM recovered_queue_drafts
      WHERE claim_id = ${command.claimId} AND thread_id = ${command.threadId} RETURNING claim_id`;
    if (!rows.length) return yield* queueDecisionError("queue_stale_selection");
  }
  for (const event of events) {
    if (event.type === "thread.deleted") {
      yield* sql`DELETE FROM recovered_queue_drafts WHERE thread_id = ${event.aggregateId}`;
    }
  }
});
