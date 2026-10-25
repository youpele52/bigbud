import type { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { ApprovalRequestId } from "@bigbud/contracts/core/baseSchemas";
import { compareActivitiesByOrder, parseUserInputQuestions } from "./session.activity.logic";
import type { PendingUserInput } from "./session.logic";

export interface AnsweredUserInput extends PendingUserInput {
  answers: Readonly<Record<string, unknown>>;
  answeredAt: string;
}

/** Reconstruct answered prompts from persisted lifecycle activities, not composer drafts. */
export function deriveAnsweredUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AnsweredUserInput[] {
  const requests = new Map<string, PendingUserInput>();
  const answers = new Map<string, Pick<AnsweredUserInput, "answers" | "answeredAt">>();
  for (const activity of activities.toSorted(compareActivitiesByOrder)) {
    const payload = activity.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.requestId !== "string") continue;
    const requestId = payload.requestId;
    if (activity.kind === "user-input.requested") {
      const questions = parseUserInputQuestions(payload);
      if (questions) {
        requests.set(requestId, {
          requestId: ApprovalRequestId.makeUnsafe(requestId),
          createdAt: activity.createdAt,
          questions,
        });
      }
    } else if (activity.kind === "user-input.resolved") {
      const value = payload.answers;
      // Providers also close cancelled prompts with an empty answer object.
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (Object.keys(value).length > 0)
          answers.set(requestId, {
            answers: value as Record<string, unknown>,
            answeredAt: activity.createdAt,
          });
      }
    } else if (activity.kind === "provider.user-input.respond.failed") {
      answers.delete(requestId);
    }
  }
  return [...requests.values()].flatMap((request) => {
    const response = answers.get(request.requestId);
    return response ? [{ ...request, ...response }] : [];
  });
}

/** Resolve stable option IDs to their labels without losing free-text or typed answers. */
export function formatUserInputAnswer(
  question: PendingUserInput["questions"][number],
  answer: unknown,
): string {
  const formatValue = (value: unknown): string => {
    if (typeof value === "string") {
      return question.options.find((option) => option.id === value)?.label ?? value;
    }
    return JSON.stringify(value) ?? "";
  };
  if (answer === undefined || answer === null || answer === "") return "Skipped";
  if (Array.isArray(answer)) return answer.length ? answer.map(formatValue).join(", ") : "Skipped";
  return formatValue(answer);
}

/** Copy the complete exchange, including unselected options and their descriptions. */
export function formatUserInputHistoryForCopy(
  input: PendingUserInput,
  answers: Readonly<Record<string, unknown>>,
): string {
  return input.questions
    .map((question, index) => {
      const label = input.questions.length > 1 ? `Question ${index + 1}` : "Question";
      const options = question.options.map(
        (option) => `- ${option.label}${option.description ? ` — ${option.description}` : ""}`,
      );
      return [
        `${label}: ${question.question}`,
        ...(options.length > 0 ? ["Options:", ...options] : []),
        `Your answer: ${formatUserInputAnswer(question, answers[question.id])}`,
      ].join("\n");
    })
    .join("\n\n");
}
