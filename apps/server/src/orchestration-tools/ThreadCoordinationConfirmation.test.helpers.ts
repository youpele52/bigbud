import type { ChatAttachment, OrchestrationEvent, ThreadId } from "@bigbud/contracts";
import type { MessageOriginSegment } from "@bigbud/contracts/orchestration/orchestration.messageOrigin.ts";
import { Effect } from "effect";

import { makeThreadCoordinationGrants } from "./Layers/ThreadCoordinationGrants.ts";
import type { ThreadCoordinationGrantsShape } from "./Services/ThreadCoordinationGrants.ts";
import type {
  ThreadCoordinationDeps,
  ThreadCoordinationProofReader,
} from "./ThreadCoordinationConfirmation.ts";

const at = "2026-11-10T12:00:00.000Z";

const base = (threadId: ThreadId, sequence: number, commandId: string | null) => ({
  sequence,
  eventId: `event-${threadId}-${sequence}`,
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: at,
  commandId,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

export function questionEvent(input: {
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly requestId: string;
  readonly questionId?: string;
  readonly question: string;
  readonly options?: ReadonlyArray<{ readonly label: string; readonly id?: string }>;
}): OrchestrationEvent {
  return {
    ...base(input.threadId, input.sequence, `provider:activity-${input.sequence}`),
    type: "thread.activity-appended",
    payload: {
      threadId: input.threadId,
      activity: {
        id: `activity-${input.sequence}`,
        tone: "info",
        kind: "user-input.requested",
        summary: "User input requested",
        payload: {
          requestId: input.requestId,
          questions: [
            {
              id: input.questionId ?? input.question,
              header: "Confirm",
              question: input.question,
              options: input.options ?? [
                { label: "Allow", description: "Allow" },
                { label: "Deny", description: "Deny" },
              ],
            },
          ],
        },
        turnId: null,
        createdAt: at,
      },
    },
  } as unknown as OrchestrationEvent;
}

export function resolvedActivityEvent(input: {
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly requestId: string;
  readonly answers: Record<string, unknown>;
}): OrchestrationEvent {
  return {
    ...base(input.threadId, input.sequence, `provider:resolved-${input.sequence}`),
    type: "thread.activity-appended",
    payload: {
      threadId: input.threadId,
      activity: {
        id: `resolved-${input.sequence}`,
        tone: "info",
        kind: "user-input.resolved",
        summary: "User input submitted",
        payload: { requestId: input.requestId, answers: input.answers },
        turnId: null,
        createdAt: at,
      },
    },
  } as unknown as OrchestrationEvent;
}

export function responseEvent(input: {
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly requestId: string;
  readonly answers: Record<string, unknown>;
  readonly commandId?: string;
}): OrchestrationEvent {
  return {
    ...base(input.threadId, input.sequence, input.commandId ?? `client-respond-${input.sequence}`),
    metadata: { requestId: input.requestId },
    type: "thread.user-input-response-requested",
    payload: {
      threadId: input.threadId,
      requestId: input.requestId,
      answers: input.answers,
      createdAt: at,
    },
  } as unknown as OrchestrationEvent;
}

export function messageEvent(input: {
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly text: string;
  readonly role?: "user" | "assistant";
  readonly originSegments?: ReadonlyArray<MessageOriginSegment>;
  readonly commandId?: string | null;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly messageId?: string;
}): OrchestrationEvent {
  return {
    ...base(
      input.threadId,
      input.sequence,
      input.commandId === undefined ? `client-submit-${input.sequence}` : input.commandId,
    ),
    type: "thread.message-sent",
    payload: {
      threadId: input.threadId,
      messageId: input.messageId ?? `message-${input.sequence}`,
      role: input.role ?? "user",
      text: input.text,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.originSegments ? { originSegments: input.originSegments } : {}),
      turnId: null,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  } as unknown as OrchestrationEvent;
}

export function queuedPromptEvent(input: {
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly text: string;
  readonly alreadySent?: boolean;
  readonly originSegments?: ReadonlyArray<MessageOriginSegment>;
  readonly commandId?: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly promptId?: string;
}): OrchestrationEvent {
  return {
    ...base(input.threadId, input.sequence, input.commandId ?? `client-queue-${input.sequence}`),
    type: "thread.prompt-queued",
    payload: {
      threadId: input.threadId,
      prompt: {
        id: input.promptId ?? `queued-${input.sequence}`,
        text: input.text,
        createdAt: at,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.originSegments ? { originSegments: input.originSegments } : {}),
        ...(input.alreadySent ? { alreadySent: true } : {}),
      },
      queuePosition: 1,
    },
  } as unknown as OrchestrationEvent;
}

export function turnStartEvent(input: {
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly messageId: string;
  readonly commandId: string | null;
}): OrchestrationEvent {
  return {
    ...base(input.threadId, input.sequence, input.commandId),
    type: "thread.turn-start-requested",
    payload: {
      threadId: input.threadId,
      messageId: input.messageId,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: at,
    },
  } as unknown as OrchestrationEvent;
}

export function flushedEvent(input: {
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly messageIds: ReadonlyArray<string>;
  readonly commandId: string;
}): OrchestrationEvent {
  return {
    ...base(input.threadId, input.sequence, input.commandId),
    type: "thread.queued-prompts-flushed",
    payload: { threadId: input.threadId, messageIds: input.messageIds },
  } as unknown as OrchestrationEvent;
}

/** A composer thread attachment, as `ChatView.sendTurn.helpers.ts` builds it. */
export const threadAttachment = (threadId: string, title = "Attached"): ChatAttachment =>
  ({
    type: "thread",
    id: `attachment-${threadId}`,
    name: title,
    mimeType: "application/x-bigbud-thread-reference",
    sizeBytes: 0,
    threadId,
    title,
  }) as ChatAttachment;

export const segment = (
  kind: MessageOriginSegment["kind"],
  actor: MessageOriginSegment["actor"],
  text: string,
): MessageOriginSegment => ({ kind, actor, text, sourceThreads: [], verified: true });

const PROOF_EVENT_TYPES = new Set([
  "thread.user-input-response-requested",
  "thread.activity-appended",
  "thread.prompt-queued",
]);

const RECENT_USER_TURN_EVENT_TYPES = new Set([
  "thread.prompt-queued",
  "thread.queued-prompts-flushed",
  "thread.turn-start-requested",
]);

/** In-memory twin of the SQL proof reader, including its type and role filters. */
export function makeProofEventLog() {
  const events: Array<OrchestrationEvent> = [];
  let sequence = 0;
  const reader: ThreadCoordinationProofReader = {
    readThreadProofEventsAfter: (input) =>
      Effect.sync(() =>
        events
          .filter(
            (event) =>
              event.aggregateId === input.threadId &&
              event.sequence > input.afterSequence &&
              (PROOF_EVENT_TYPES.has(event.type) ||
                (event.type === "thread.message-sent" && event.payload.role === "user")),
          )
          .toSorted((left, right) => left.sequence - right.sequence)
          .slice(0, input.limit),
      ),
    readThreadRecentUserTurnEvents: (input) =>
      Effect.sync(() =>
        events
          .filter(
            (event) =>
              event.aggregateId === input.threadId &&
              (RECENT_USER_TURN_EVENT_TYPES.has(event.type) ||
                (event.type === "thread.message-sent" && event.payload.role === "user")),
          )
          .toSorted((left, right) => left.sequence - right.sequence)
          .slice(-input.limit),
      ),
    readThreadMaxSequence: (threadId) =>
      Effect.sync(() =>
        events.reduce(
          (max, event) => (event.aggregateId === threadId ? Math.max(max, event.sequence) : max),
          0,
        ),
      ),
  };
  return {
    events,
    reader,
    nextSequence: () => ++sequence,
    push: (...next: ReadonlyArray<OrchestrationEvent>) => {
      for (const event of next) sequence = Math.max(sequence, event.sequence);
      events.push(...next);
    },
  };
}

export function makeTestCoordination(
  options: { readonly now?: () => number; readonly generateCode?: () => string } = {},
): {
  readonly grants: ThreadCoordinationGrantsShape;
  readonly log: ReturnType<typeof makeProofEventLog>;
  readonly coordination: ThreadCoordinationDeps;
} {
  const grants = Effect.runSync(makeThreadCoordinationGrants(options));
  const log = makeProofEventLog();
  return { grants, log, coordination: { grants, eventStore: log.reader } };
}

/** Records a client "Allow" answer to the server-prescribed question for `code`/`projectTitle`. */
export function pushClientAnswer(
  log: ReturnType<typeof makeProofEventLog>,
  input: {
    readonly callerThreadId: ThreadId;
    readonly question: string;
    readonly answer: string;
  },
) {
  const requestId = `request-${log.nextSequence()}`;
  log.push(
    questionEvent({
      threadId: input.callerThreadId,
      sequence: log.nextSequence(),
      requestId,
      question: input.question,
    }),
    responseEvent({
      threadId: input.callerThreadId,
      sequence: log.nextSequence(),
      requestId,
      answers: { [input.question]: input.answer },
    }),
  );
}
