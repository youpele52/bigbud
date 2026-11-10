/**
 * Pure matching of a cross-project confirmation challenge against the caller thread's durable
 * events. Trust comes only from the event type (a client `thread.user-input.respond`) or from
 * user-typed message provenance; never from `user-input.resolved` activities or `actor_kind`.
 *
 * @module ThreadCoordinationConfirmation.logic
 */
import type { OrchestrationEvent, ThreadId } from "@bigbud/contracts";

import { extractActivityRequestId } from "../orchestration/Layers/ProjectionPipeline.helpers.ts";
import type {
  ThreadCoordinationChallenge,
  ThreadCoordinationIssuedChallenge,
} from "./Services/ThreadCoordinationGrants.ts";
import { classifyConfirmationReply } from "./ThreadCoordinationConfirmation.phrases.ts";
import { isUntrustedCommandId, trustedChatText } from "./ThreadCoordinationConfirmation.trust.ts";
import {
  THREAD_COORDINATION_ALLOW_LABEL,
  THREAD_COORDINATION_DENY_LABEL,
} from "./ThreadCoordinationConfirmation.result.ts";

export type ThreadCoordinationProofVerdict = "allowed" | "denied" | "none";

interface ProofQuestion {
  readonly id: string;
  readonly text: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly id?: string }>;
}

const normalized = (value: string) => value.trim().toLowerCase();

function parseQuestions(payload: unknown): ReadonlyArray<ProofQuestion> {
  const questions = (payload as { readonly questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((entry): ReadonlyArray<ProofQuestion> => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, header, question, options } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof question !== "string" || !Array.isArray(options)) {
      return [];
    }
    return [
      {
        id,
        text: `${typeof header === "string" ? header : ""}\n${question}`,
        options: options.flatMap((option) => {
          const { label, id: optionId } = (option ?? {}) as Record<string, unknown>;
          if (typeof label !== "string") return [];
          return [{ label, ...(typeof optionId === "string" ? { id: optionId } : {}) }];
        }),
      },
    ];
  });
}

function answerValues(answer: unknown): ReadonlyArray<string> {
  const values = Array.isArray(answer) ? answer : [answer];
  return values.filter((value): value is string => typeof value === "string");
}

const optionLabelled = (question: ProofQuestion, label: string) =>
  question.options.find((option) => normalized(option.label) === normalized(label));

const answerSelects = (
  values: ReadonlyArray<string>,
  option: { readonly label: string; readonly id?: string } | undefined,
) =>
  option !== undefined &&
  values.some(
    (value) =>
      normalized(value) === normalized(option.label) ||
      (option.id !== undefined && value === option.id),
  );

/** The random code binds the question to the challenge; an `Allow` option must be offered. */
function questionVerdict(
  question: ProofQuestion,
  answers: Readonly<Record<string, unknown>>,
  code: string,
): ThreadCoordinationProofVerdict {
  if (!normalized(question.text).includes(normalized(code))) return "none";
  const allow = optionLabelled(question, THREAD_COORDINATION_ALLOW_LABEL);
  if (allow === undefined) return "none";
  const values = answerValues(answers[question.id]);
  // A Deny selection wins over an Allow in the same (multi-select) answer.
  if (answerSelects(values, optionLabelled(question, THREAD_COORDINATION_DENY_LABEL))) {
    return "denied";
  }
  return answerSelects(values, allow) ? "allowed" : "none";
}

const CODE_PATTERN = /\bBB-[A-Z2-7]{8}\b/gi;

type IssuedRef = Pick<
  ThreadCoordinationIssuedChallenge,
  "code" | "streamSequenceFloor" | "issueOrder" | "resolvedAtSequence"
>;

/**
 * Whether a trusted chat reply at `sequence` is about `challenge`. A reply naming codes is about
 * exactly those challenges. Otherwise it is about the most recently issued challenge that was
 * still pending when it was typed: issued before it, and not resolved before it.
 */
function replyTargets(input: {
  readonly text: string;
  readonly sequence: number;
  readonly challenge: IssuedRef;
  readonly issued: ReadonlyArray<IssuedRef>;
}): boolean {
  const named = (input.text.match(CODE_PATTERN) ?? []).map((code) => code.toUpperCase());
  if (named.length > 0) return named.includes(input.challenge.code.toUpperCase());
  let latest: IssuedRef | undefined;
  for (const record of input.issued) {
    const pending =
      record.streamSequenceFloor < input.sequence &&
      (record.resolvedAtSequence === undefined || record.resolvedAtSequence >= input.sequence);
    if (pending && (latest === undefined || record.issueOrder > latest.issueOrder)) {
      latest = record;
    }
  }
  return latest?.code === input.challenge.code;
}

/**
 * Decides a challenge from the caller thread's events (ascending) after its floor.
 * - Card: a client answer to a question asked earlier in the same caller-thread scan that
 *   contains the code and offers `Allow`.
 * - Chat: trusted user-typed replies about this challenge (see `replyTargets`). The latest one
 *   decides an Allow.
 * Any decisive Deny, card or chat, stands for the whole challenge: a later "yes" or chatter
 * cannot undo it.
 */
export function matchThreadCoordinationProof(input: {
  readonly callerThreadId: ThreadId;
  readonly challenge: Pick<ThreadCoordinationChallenge, "code" | "streamSequenceFloor"> &
    Partial<Pick<ThreadCoordinationChallenge, "issueOrder">>;
  /** The caller's issued challenges; omitted, every reply after the floor is about this one. */
  readonly issuedChallenges?: ReadonlyArray<IssuedRef> | undefined;
  /** The question shown for this challenge, so a reply quoting it is not decisive. */
  readonly question?: string | undefined;
  readonly events: ReadonlyArray<OrchestrationEvent>;
}): ThreadCoordinationProofVerdict {
  const { callerThreadId, challenge } = input;
  const self: IssuedRef = {
    code: challenge.code,
    streamSequenceFloor: challenge.streamSequenceFloor,
    issueOrder: challenge.issueOrder ?? Number.MAX_SAFE_INTEGER,
  };
  // The challenge being verified is pending by definition, whatever the history says.
  const issued = [
    ...(input.issuedChallenges ?? []).filter((record) => record.code !== challenge.code),
    self,
  ];
  const events = input.events
    .filter(
      (event) =>
        event.aggregateKind === "thread" &&
        event.aggregateId === callerThreadId &&
        event.sequence > challenge.streamSequenceFloor &&
        (event.payload as { readonly threadId?: unknown }).threadId === callerThreadId,
    )
    .toSorted((left, right) => left.sequence - right.sequence);
  // Only questions asked before (lower sequence than) an answer can be answered by it.
  const askedBefore = new Map<string, ReadonlyArray<ProofQuestion>>();
  let cardAllowed = false;
  let latestChatVerdict: ThreadCoordinationProofVerdict = "none";
  for (const event of events) {
    if (event.type === "thread.activity-appended") {
      const activity = event.payload.activity;
      if (activity.kind !== "user-input.requested") continue;
      const requestId = extractActivityRequestId(activity.payload) ?? event.metadata.requestId;
      if (requestId) askedBefore.set(requestId, parseQuestions(activity.payload));
      continue;
    }
    if (event.type === "thread.user-input-response-requested") {
      if (isUntrustedCommandId(event.commandId)) continue;
      for (const question of askedBefore.get(event.payload.requestId) ?? []) {
        const verdict = questionVerdict(question, event.payload.answers, challenge.code);
        if (verdict === "denied") return "denied";
        if (verdict === "allowed") cardAllowed = true;
      }
      continue;
    }
    const text = trustedChatText(event);
    if (text === null) continue;
    if (!replyTargets({ text, sequence: event.sequence, challenge: self, issued })) continue;
    latestChatVerdict = classifyConfirmationReply(text, { question: input.question });
    if (latestChatVerdict === "denied") return "denied";
  }
  return cardAllowed || latestChatVerdict === "allowed" ? "allowed" : "none";
}
