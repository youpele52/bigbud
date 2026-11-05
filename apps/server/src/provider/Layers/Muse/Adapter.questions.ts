import type {
  ProviderRuntimeEvent,
  ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";

interface NativeUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  /** Wire shape is `{ mode: "single" | "multiple" }` (a bare string is also tolerated). */
  readonly selection?: { readonly mode?: string } | string;
  readonly options?: ReadonlyArray<{
    readonly id?: string;
    readonly label: string;
    readonly description?: string;
  }>;
}

/** Validate every entry before mapping: SDK callbacks run directly in its read loop. */
function nativeQuestions(value: unknown): ReadonlyArray<NativeUserInputQuestion> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  for (const question of value) {
    if (
      !question ||
      typeof question !== "object" ||
      typeof question.id !== "string" ||
      !question.id.trim() ||
      typeof question.header !== "string" ||
      !question.header.trim() ||
      typeof question.question !== "string" ||
      !question.question.trim()
    )
      return undefined;
    const selection = question.selection;
    if (
      selection !== undefined &&
      selection !== "single" &&
      selection !== "multiple" &&
      !(
        selection &&
        typeof selection === "object" &&
        (selection.mode === "single" || selection.mode === "multiple")
      )
    )
      return undefined;
    if (
      question.options !== undefined &&
      (!Array.isArray(question.options) ||
        question.options.some((option: unknown) => {
          if (!option || typeof option !== "object") return true;
          const entry = option as Record<string, unknown>;
          return (
            typeof entry.label !== "string" ||
            !entry.label.trim() ||
            (entry.id !== undefined && typeof entry.id !== "string") ||
            (entry.description !== undefined && typeof entry.description !== "string")
          );
        }))
    )
      return undefined;
  }
  if (new Set(value.map((question) => question.id)).size !== value.length) return undefined;
  return value as ReadonlyArray<NativeUserInputQuestion>;
}

/**
 * Map a native userInput/request to the canonical user-input.requested
 * event. Forms that cannot be represented are rejected explicitly by the
 * adapter (userInput/cancel) rather than answered with an empty string.
 */
export function mapUserInputRequested(
  threadId: ThreadId,
  params: Record<string, unknown>,
): ProviderRuntimeEvent | undefined {
  const userInputId = params.userInputId;
  const questions = nativeQuestions(params.questions);
  if (typeof userInputId !== "string" || !userInputId.trim() || !questions) {
    return undefined;
  }
  return {
    eventId: `muse-userinput-${userInputId}`,
    provider: "muse",
    threadId,
    createdAt: new Date().toISOString(),
    ...(typeof params.turnId === "string" ? { turnId: params.turnId as TurnId } : {}),
    requestId: userInputId,
    type: "user-input.requested",
    payload: {
      questions: questions.map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        options: (question.options ?? []).map(
          (option: {
            readonly id?: string;
            readonly label: string;
            readonly description?: string;
          }) => {
            const mapped: { id?: string; label: string; description: string } = {
              label: option.label,
              description: option.description?.trim() ? option.description : option.label,
            };
            if (option.id) mapped.id = option.id;
            return mapped;
          },
        ),
        multiSelect:
          question.selection === "multiple" ||
          (typeof question.selection === "object" && question.selection?.mode === "multiple"),
      })),
    },
  } as unknown as ProviderRuntimeEvent;
}

/** Convert canonical answers to the native answer entries; undefined when unrepresentable. */
export function toNativeAnswers(
  params: Record<string, unknown>,
  answers: ProviderUserInputAnswers,
): ReadonlyArray<Record<string, unknown>> | undefined {
  const questions = nativeQuestions(params.questions);
  if (!questions) return undefined;
  const entries: Array<Record<string, unknown>> = [];
  for (const question of questions) {
    const value = answers[question.id];
    if (typeof value === "string") {
      const multiple =
        question.selection === "multiple" ||
        (typeof question.selection === "object" && question.selection?.mode === "multiple");
      entries.push(
        multiple
          ? { questionId: question.id, selectedLabels: [value] }
          : { questionId: question.id, selectedLabel: value },
      );
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      entries.push({ questionId: question.id, selectedLabels: value });
    } else if (value !== undefined) {
      entries.push({ questionId: question.id, freeText: String(value).slice(0, 500) });
    } else {
      return undefined;
    }
  }
  return entries;
}

import type { MuseAdapterShape } from "../../Services/Muse/Adapter.ts";
import { museValidationError } from "./Client.errors.ts";
import type { MuseAdapterContext } from "./Adapter.types.ts";
import { Effect } from "effect";
import { mapMuseRequestError } from "./Client.errors.ts";
import { resolveMuseUserInput, validateMuseAck } from "./Adapter.interactions.ts";
import { stampMuseEvent } from "./Adapter.sessionView.ts";

/** Answer a pending Muse user-input prompt in its native answer shape. */
export const makeMuseUserInputResponder = (
  ctx: MuseAdapterContext,
): MuseAdapterShape["respondToUserInput"] =>
  Effect.fn("Muse.respondToUserInput")(function* (threadId, requestId, answers) {
    const session = yield* ctx.getSession(threadId);
    const pending = session.pendingUserInputs.get(String(requestId));
    if (!pending) {
      return yield* museValidationError(
        "respondToUserInput",
        "Muse user-input request is stale or unknown.",
        "invalid-request",
      );
    }
    const native = toNativeAnswers(pending.params, answers);
    if (!native) {
      return yield* museValidationError(
        "respondToUserInput",
        "Muse user-input answers cannot be represented for this prompt.",
        "invalid-request",
      );
    }
    const cid = session.transport.mintCommandId();
    const raw = yield* Effect.tryPromise({
      try: () =>
        session.transport.command(
          "userInput/answer",
          {
            commandId: cid,
            sessionId: pending.sessionId,
            userInputId: pending.requestId,
            answers: native,
          },
          cid,
        ),
      catch: (error) => mapMuseRequestError("userInput/answer", error, "unsafe-to-replay"),
    });
    yield* Effect.try({
      try: () => validateMuseAck(raw, "userInput/answer", cid, { userInputId: pending.requestId }),
      catch: (cause) => mapMuseRequestError("userInput/answer", cause, "unsafe-to-replay"),
    });
    const event = resolveMuseUserInput(session, String(requestId), answers);
    if (event) yield* ctx.publish(stampMuseEvent(event, session.sessionEpoch));
  });
