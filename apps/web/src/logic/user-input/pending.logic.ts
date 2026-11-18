// Compatibility facade; new consumers use the explicit shared runtime subpath.
export {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  getPendingUserInputOptionIdentity,
  isPendingUserInputOptionSelected,
  pendingUserInputAcceptsContext,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  withPendingUserInputDraftAnswer,
  type PendingUserInputDraftAnswer,
  type PendingUserInputProgress,
} from "@bigbud/shared/pendingUserInput";
