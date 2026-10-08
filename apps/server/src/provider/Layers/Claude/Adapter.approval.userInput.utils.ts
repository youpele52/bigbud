import type { ProviderUserInputAnswers, UserInputQuestion } from "@bigbud/contracts";

/** Keep elicitation content within the SDK's supported scalar/array values. */
export function elicitationContent(
  answers: ProviderUserInputAnswers,
): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      content[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      content[key] = value;
    }
  }
  return content;
}

/** Normalize the existing AskUserQuestion payload for the user-input event. */
export function claudeUserInputQuestions(
  toolInput: Record<string, unknown>,
): Array<UserInputQuestion> {
  const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  return rawQuestions.map((question: Record<string, unknown>, index: number) => ({
    id:
      typeof question.question === "string" && question.question.length > 0
        ? question.question
        : `q-${index}`,
    header: typeof question.header === "string" ? question.header : `Question ${index + 1}`,
    question: typeof question.question === "string" ? question.question : "",
    options: Array.isArray(question.options)
      ? question.options.map((option: Record<string, unknown>) => ({
          label: typeof option.label === "string" ? option.label : "",
          description: typeof option.description === "string" ? option.description : "",
        }))
      : [],
    multiSelect: typeof question.multiSelect === "boolean" ? question.multiSelect : false,
  }));
}
