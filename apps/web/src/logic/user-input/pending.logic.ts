import type { UserInputQuestion } from "@bigbud/contracts";

export interface PendingUserInputDraftAnswer {
  /** Stable UI identities for selections, used when labels are duplicated. */
  selectedOptionKeys?: string[];
  /** Cursor option ids; absent for legacy/provider-neutral label answers. */
  selectedOptionIds?: string[];
  selectedOptionLabels?: string[];
  customAnswer?: string;
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabels: string[];
  selectedOptionKeys: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedOptionLabels(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized));
}

function optionIdentity(option: UserInputQuestion["options"][number], optionIndex: number): string {
  return option.id ? `id:${option.id}` : `index:${optionIndex}`;
}

function normalizeSelectedOptionKeys(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
}

function selectedOptionEntries(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): ReadonlyArray<{ readonly option: UserInputQuestion["options"][number]; readonly key: string }> {
  const explicitKeys = normalizeSelectedOptionKeys(draft?.selectedOptionKeys);
  if (explicitKeys.length > 0) {
    return explicitKeys.flatMap((key) => {
      const optionIndex = question.options.findIndex(
        (option, index) => optionIdentity(option, index) === key,
      );
      const option = question.options[optionIndex];
      return option ? [{ option, key }] : [];
    });
  }

  const selectedIds = new Set(normalizeSelectedOptionLabels(draft?.selectedOptionIds));
  const selectedLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
  const usedLabelIndexes = new Set<number>();
  return question.options.flatMap((option, index) => {
    const matchesId = option.id !== undefined && selectedIds.has(option.id);
    const labelIndex = selectedLabels.findIndex(
      (label, candidateIndex) => label === option.label && !usedLabelIndexes.has(candidateIndex),
    );
    if (!matchesId && labelIndex === -1) {
      return [];
    }
    if (labelIndex !== -1) {
      usedLabelIndexes.add(labelIndex);
    }
    return [{ option, key: optionIdentity(option, index) }];
  });
}

function selectedOptionValues(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string[] {
  return selectedOptionEntries(question, draft).map(({ option }) => option.id ?? option.label);
}

export function getPendingUserInputOptionIdentity(
  option: UserInputQuestion["options"][number],
  optionIndex: number,
): string {
  return optionIdentity(option, optionIndex);
}

export function isPendingUserInputOptionSelected(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  option: UserInputQuestion["options"][number],
  optionIndex: number,
): boolean {
  const key = optionIdentity(option, optionIndex);
  return selectedOptionEntries(question, draft).some((entry) => entry.key === key);
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | string[] | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }

  const selectedOptions = selectedOptionValues(question, draft);
  if (question.multiSelect) {
    return selectedOptions.length > 0 ? selectedOptions : null;
  }

  return selectedOptions[0] ?? null;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  if (customAnswer.trim().length > 0) {
    return { customAnswer };
  }

  const selectedOptionKeys = normalizeSelectedOptionKeys(draft?.selectedOptionKeys);
  const selectedOptionIds = normalizeSelectedOptionLabels(draft?.selectedOptionIds);
  const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

  return {
    customAnswer,
    ...(selectedOptionKeys.length > 0 ? { selectedOptionKeys } : {}),
    ...(selectedOptionIds.length > 0 ? { selectedOptionIds } : {}),
    ...(selectedOptionLabels && selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
  };
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionOrLabel: UserInputQuestion["options"][number] | string,
  optionIndex?: number,
): PendingUserInputDraftAnswer {
  const resolvedOptionIndex =
    typeof optionOrLabel === "string"
      ? question.options.findIndex((option) => option.label === optionOrLabel)
      : (optionIndex ?? question.options.indexOf(optionOrLabel));
  const option =
    typeof optionOrLabel === "string" ? question.options[resolvedOptionIndex] : optionOrLabel;
  if (!option || resolvedOptionIndex < 0) {
    return { customAnswer: "" };
  }
  const key = optionIdentity(option, resolvedOptionIndex);
  const selectedEntries = selectedOptionEntries(question, draft);
  const isSelected = selectedEntries.some((entry) => entry.key === key);
  const nextEntries = isSelected
    ? selectedEntries.filter((entry) => entry.key !== key)
    : question.multiSelect
      ? [...selectedEntries, { option, key }]
      : [{ option, key }];
  const selectedOptionIds = nextEntries.flatMap(({ option: entryOption }) =>
    entryOption.id ? [entryOption.id] : [],
  );
  const selectedOptionLabels = nextEntries.flatMap(({ option: entryOption }) =>
    entryOption.id ? [] : [entryOption.label],
  );
  const hasDuplicateLabels = question.options.some(
    (candidate, index) =>
      !candidate.id &&
      question.options.some(
        (other, otherIndex) => index !== otherIndex && !other.id && other.label === candidate.label,
      ),
  );

  return {
    customAnswer: "",
    ...(selectedOptionIds.length > 0 ? { selectedOptionIds } : {}),
    ...(selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
    ...(hasDuplicateLabels ? { selectedOptionKeys: nextEntries.map((entry) => entry.key) } : {}),
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (!answer) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(question, draftAnswers[question.id]) ? count + 1 : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => !resolvePendingUserInputAnswer(question, draftAnswers[question.id]),
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = activeQuestion
    ? resolvePendingUserInputAnswer(activeQuestion, activeDraft)
    : null;
  const customAnswer = activeDraft?.customAnswer ?? "";
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionLabels: activeQuestion
      ? selectedOptionEntries(activeQuestion, activeDraft).map(({ option }) => option.label)
      : [],
    selectedOptionKeys: activeQuestion
      ? selectedOptionEntries(activeQuestion, activeDraft).map((entry) => entry.key)
      : [],
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim().length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: Boolean(resolvedAnswer),
  };
}
