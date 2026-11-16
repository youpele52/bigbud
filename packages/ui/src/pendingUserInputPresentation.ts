/** Presentation only: callers retain provider-specific answer/context admission. */
export const pendingUserInputAttentionLabel = "Needs you";

export const pendingUserInputPresentationStyles = {
  title: "text-sm font-medium text-foreground",
  detail: "mt-0.5 whitespace-pre-wrap break-words text-sm text-muted-foreground",
  hint: "mt-2 text-xs text-muted-foreground",
} as const;

export function describePendingUserInputQuestion(input: {
  readonly header: string;
  readonly question: string;
  readonly questionCount: number;
  readonly questionIndex: number;
}) {
  return {
    title: `${input.questionCount > 1 ? `${input.questionIndex + 1}. ` : ""}${input.header || input.question}`,
    detail: input.header && input.question !== input.header ? input.question : null,
    counterLabel:
      input.questionCount > 1 ? `${input.questionIndex + 1} of ${input.questionCount}` : null,
  };
}

export function pendingUserInputComposerHint(input: {
  readonly hasOptions: boolean;
  readonly acceptsContext: boolean;
  readonly singleChoiceAsksForMultiple: boolean;
}): string | null {
  if (!input.hasOptions) return "Type your answer in the message box and send.";
  if (input.singleChoiceAsksForMultiple) {
    return input.acceptsContext
      ? "Only one option can be picked here. Name any others in the message box."
      : "Only one option can be picked here.";
  }
  return input.acceptsContext
    ? "Add context in the message box, or just send your selection."
    : null;
}
