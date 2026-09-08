/**
 * Public Docs: https://cursor.com/docs/cli/acp#cursor-extension-methods
 * Additional reference provided by the Cursor team: https://anysphere.enterprise.slack.com/files/U068SSJE141/F0APT1HSZRP/cursor-acp-extension-method-schemas.md
 */
import type { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";
import { Schema } from "effect";

const CursorAskQuestionOption = Schema.Struct({
  id: Schema.optional(Schema.String),
  label: Schema.String,
});

const CursorAskQuestion = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(CursorAskQuestionOption),
  allowMultiple: Schema.optional(Schema.Boolean),
});

export const CursorAskQuestionRequest = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  questions: Schema.Array(CursorAskQuestion),
});

const CursorTodoStatus = Schema.String;

const CursorTodo = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.optional(CursorTodoStatus),
});

const CursorPlanPhase = Schema.Struct({
  name: Schema.String,
  todos: Schema.Array(CursorTodo),
});

export const CursorCreatePlanRequest = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.optional(Schema.String),
  overview: Schema.optional(Schema.String),
  plan: Schema.String,
  todos: Schema.Array(CursorTodo),
  isProject: Schema.optional(Schema.Boolean),
  phases: Schema.optional(Schema.Array(CursorPlanPhase)),
});

export const CursorUpdateTodosRequest = Schema.Struct({
  toolCallId: Schema.String,
  todos: Schema.Array(CursorTodo),
  merge: Schema.Boolean,
});

export type CursorAskQuestionResponse =
  | {
      readonly outcome: {
        readonly outcome: "answered";
        readonly answers: ReadonlyArray<{
          readonly questionId: string;
          readonly selectedOptionIds: ReadonlyArray<string>;
        }>;
      };
    }
  | { readonly outcome: { readonly outcome: "skipped" } }
  | { readonly outcome: { readonly outcome: "cancelled" } };

export type CursorCreatePlanResponse = {
  readonly outcome: {
    readonly outcome: "accepted";
    readonly planUri?: string;
  };
};

export function extractAskQuestions(
  params: typeof CursorAskQuestionRequest.Type,
): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question) => ({
    id: question.id,
    header: "Question",
    question: question.prompt,
    multiSelect: question.allowMultiple === true,
    options: question.options.map((option) => ({
      ...(option.id?.trim() ? { id: option.id.trim() } : {}),
      label: option.label,
      description: option.label,
    })),
  }));
}

function skippedAskQuestionResponse(): CursorAskQuestionResponse {
  return { outcome: { outcome: "skipped" } };
}

export function buildCursorAskQuestionSkippedResponse(): CursorAskQuestionResponse {
  return skippedAskQuestionResponse();
}

export function buildCursorAskQuestionCancelledResponse(): CursorAskQuestionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function answerValues(value: unknown): ReadonlyArray<string> | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  if (!value.every((entry): entry is string => typeof entry === "string" && entry.length > 0)) {
    return undefined;
  }
  return value;
}

/** Converts provider-neutral answers to Cursor's option-id response envelope. */
export function buildCursorAskQuestionAnsweredResponse(input: {
  readonly request: typeof CursorAskQuestionRequest.Type;
  readonly answers: Readonly<Record<string, unknown>>;
}): CursorAskQuestionResponse {
  if (input.request.questions.length === 0) {
    return skippedAskQuestionResponse();
  }

  const answers = input.request.questions.map((question) => {
    const values = answerValues(input.answers[question.id]);
    if (!values) {
      return undefined;
    }

    const selectedOptionIds: string[] = [];
    for (const value of values) {
      const exactIdOption = question.options.find((option) => option.id?.trim() === value);
      const option =
        exactIdOption ??
        (() => {
          const labelMatches = question.options.filter((candidate) => candidate.label === value);
          return labelMatches.length === 1 ? labelMatches[0] : undefined;
        })();
      const optionId = option?.id?.trim();
      if (!optionId) {
        return undefined;
      }
      if (!selectedOptionIds.includes(optionId)) {
        selectedOptionIds.push(optionId);
      }
    }

    return { questionId: question.id, selectedOptionIds };
  });

  if (answers.some((answer) => answer === undefined)) {
    return skippedAskQuestionResponse();
  }
  return {
    outcome: {
      outcome: "answered",
      answers: answers as ReadonlyArray<{
        readonly questionId: string;
        readonly selectedOptionIds: ReadonlyArray<string>;
      }>,
    },
  };
}

export function buildCursorAskQuestionResponse(input: {
  readonly request: typeof CursorAskQuestionRequest.Type;
  readonly resolution:
    | { readonly outcome: "answered"; readonly answers: Readonly<Record<string, unknown>> }
    | { readonly outcome: "cancelled" };
}): CursorAskQuestionResponse {
  return input.resolution.outcome === "cancelled"
    ? buildCursorAskQuestionCancelledResponse()
    : buildCursorAskQuestionAnsweredResponse({
        request: input.request,
        answers: input.resolution.answers,
      });
}

export function buildCursorCreatePlanAcceptedResponse(planUri?: string): CursorCreatePlanResponse {
  return {
    outcome: {
      outcome: "accepted",
      ...(planUri ? { planUri } : {}),
    },
  };
}

export function extractPlanMarkdown(params: typeof CursorCreatePlanRequest.Type): string {
  return params.plan || "# Plan\n\n(Cursor did not supply plan text.)";
}

export function extractTodosAsPlan(params: typeof CursorUpdateTodosRequest.Type): {
  readonly explanation?: string;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} {
  const plan = params.todos.flatMap((todo) => {
    const step = todo.content?.trim() ?? todo.title?.trim() ?? "";
    if (step === "") {
      return [];
    }
    const status: "pending" | "inProgress" | "completed" =
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress" || todo.status === "inProgress"
          ? "inProgress"
          : "pending";
    return [{ step, status }];
  });
  return { plan };
}
